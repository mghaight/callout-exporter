/* eslint-disable no-useless-escape */
const { Plugin, Notice, TFile, normalizePath } = require("obsidian");

/**
 * =========================
 * USER-EDITABLE SETTINGS
 * =========================
 *
 * Add any callout identifiers you want to track here.
 * These correspond to:  > [!todo]   > [!question]   etc.
 *
 * Default:
 */
const CALLOUT_TYPES = ["todo", "questions"];

// Where to put master files. "" means vault root.
const MASTER_FOLDER = "";

/**
 * =========================
 * INTERNAL TUNING
 * =========================
 */
const SYNC_DEBOUNCE_MS = 250;
const SUPPRESS_MS = 700;

function uniqLower(arr) {
    return Array.from(
        new Set(
            arr
                .map((s) =>
                    String(s || "")
                        .trim()
                        .toLowerCase(),
                )
                .filter(Boolean),
        ),
    );
}

function generateId(len = 8) {
    // base36 id, low collision risk for personal vault usage
    let out = "";
    while (out.length < len) out += Math.random().toString(36).slice(2);
    return out.slice(0, len);
}

function masterPathForType(type) {
    const name = `${type}.md`;
    return normalizePath(MASTER_FOLDER ? `${MASTER_FOLDER}/${name}` : name);
}

function isAlreadyExistsError(e) {
    const code = e?.code ? String(e.code).toUpperCase() : "";
    if (code === "EEXIST") return true;

    const msg = (e?.message ?? e?.toString?.() ?? String(e)).toLowerCase();
    return msg.includes("already exists") || msg.includes("eexist");
}

function isMarkdownFile(file) {
    return file instanceof TFile && file.extension.toLowerCase() === "md";
}

function parseCalloutStart(line) {
    // Supports: > [!todo]  > [!todo]+ Title  > [!todo]- Title
    const m = line.match(/^>\s*\[!([^\]\s]+)\]/i);
    if (!m) return null;
    return m[1].toLowerCase();
}

function unquoteLine(line) {
    // Remove a single leading blockquote marker: ">" or "> "
    return line.replace(/^>\s?/, "");
}

function quoteBodyLines(bodyLines) {
    // In a callout blockquote: blank line should be ">" to remain inside the blockquote.
    return bodyLines.map((l) => (String(l).trim() === "" ? ">" : `> ${l}`));
}

function trimTrailingBlankLines(lines) {
    const out = lines.slice();
    while (out.length && String(out[out.length - 1]).trim() === "") out.pop();
    return out;
}

function parseBlockId(line) {
    const m = String(line || "")
        .trim()
        .match(/^\^([A-Za-z0-9_-]+)\s*$/);
    return m ? m[1] : null;
}

/**
 * Extract tracked callouts from a note.
 * Optionally inserts missing block IDs (recommended for your workflow).
 *
 * Returns:
 *  {
 *    text: (possibly patched),
 *    callouts: [
 *      { type, blockId, bodyLines, startLine, quoteEndLine, idLine }
 *    ]
 *  }
 */
function extractTrackedCallouts(
    text,
    trackedTypes,
    { autoInsertIds = true } = {},
) {
    trackedTypes = new Set(uniqLower(trackedTypes));
    const lines = text.split(/\r?\n/);
    const callouts = [];

    for (let i = 0; i < lines.length; i++) {
        const type = parseCalloutStart(lines[i]);
        if (!type || !trackedTypes.has(type)) continue;

        const startLine = i;

        // Consume blockquote lines that belong to the callout.
        let j = i + 1;
        const body = [];
        while (
            j < lines.length &&
            String(lines[j]).trimStart().startsWith(">")
        ) {
            body.push(unquoteLine(lines[j]));
            j++;
        }
        const quoteEndLine = j; // first line after the blockquote

        // Look for block id after the callout, allowing blank lines.
        let k = quoteEndLine;
        while (k < lines.length && String(lines[k]).trim() === "") k++;
        let blockId = k < lines.length ? parseBlockId(lines[k]) : null;
        let idLine = blockId ? k : null;

        // If missing, insert:
        // (blank line)
        // ^id
        // (blank line)
        if (!blockId && autoInsertIds) {
            blockId = generateId();

            let insertAt = quoteEndLine;

            // Ensure blank line before ^id
            if (
                insertAt >= lines.length ||
                String(lines[insertAt]).trim() !== ""
            ) {
                lines.splice(insertAt, 0, "");
                insertAt++;
            }

            lines.splice(insertAt, 0, `^${blockId}`);
            idLine = insertAt;
            insertAt++;

            // Ensure blank line after ^id
            if (
                insertAt >= lines.length ||
                String(lines[insertAt]).trim() !== ""
            ) {
                lines.splice(insertAt, 0, "");
            }

            // Adjust loop index to avoid re-processing inserted lines
            i = idLine;
        } else {
            // Skip ahead (but keep i progressing naturally)
            i = idLine != null ? idLine : quoteEndLine - 1;
        }

        callouts.push({
            type,
            blockId,
            bodyLines: trimTrailingBlankLines(body),
            startLine,
            quoteEndLine,
            idLine,
        });
    }

    return { text: lines.join("\n"), callouts };
}

/**
 * Master entry parsing.
 * We treat each export chunk as:
 *
 * [Display](path/to/note.md#^blockid)
 * <body lines...>
 * (until next such link line or EOF)
 */
function parseMasterLinkLine(line) {
    line = String(line || "").trim();

    // Markdown link form:
    // [Temples](temples.md#^123kl98)
    const m = line.match(/^\[([^\]]+)\]\((.+?)#\^([A-Za-z0-9_-]+)\)\s*$/);
    if (m) {
        const display = m[1];
        const rawPath = m[2];
        const blockId = m[3];
        let decodedPath = rawPath;
        try {
            decodedPath = decodeURI(rawPath);
        } catch (_) {
            // keep as-is
        }
        return {
            display,
            path: normalizePath(decodedPath),
            blockId,
            format: "md",
        };
    }

    // (Optional) Wiki link form support:
    // [[temples.md#^123kl98|Temples]]
    const w = line.match(
        /^\[\[([^|\]]+?)#\^([A-Za-z0-9_-]+)\|([^\]]+?)\]\]\s*$/,
    );
    if (w) {
        const rawPath = w[1];
        const blockId = w[2];
        const display = w[3];
        let decodedPath = rawPath;
        try {
            decodedPath = decodeURI(rawPath);
        } catch (_) {}
        return {
            display,
            path: normalizePath(decodedPath),
            blockId,
            format: "wiki",
        };
    }

    return null;
}

function parseMasterChunks(text) {
    const lines = text.split(/\r?\n/);
    const chunks = [];

    for (let i = 0; i < lines.length; i++) {
        const head = parseMasterLinkLine(lines[i]);
        if (!head) continue;

        const start = i;
        let j = i + 1;
        while (j < lines.length) {
            if (parseMasterLinkLine(lines[j])) break;
            j++;
        }

        const rawBody = lines.slice(i + 1, j);
        const bodyLines = trimTrailingBlankLines(rawBody);

        chunks.push({
            start,
            end: j, // exclusive
            display: head.display,
            sourcePath: head.path,
            blockId: head.blockId,
            bodyLines,
        });

        i = j - 1;
    }

    return { lines, chunks };
}

function buildMasterChunkLines({ display, sourcePath, blockId, bodyLines }) {
    // Encode only the path portion for markdown link safety.
    const encodedPath = encodeURI(sourcePath);
    const linkLine = `[${display}](${encodedPath}#^${blockId})`;
    // Blank line after each chunk for readability + robust chunk boundaries.
    return [linkLine, ...bodyLines, ""];
}

module.exports = class CalloutMasterExportPlugin extends Plugin {
    async onload() {
        this.trackedTypes = uniqLower(CALLOUT_TYPES);
        this.masterPathsByType = new Map(
            this.trackedTypes.map((t) => [t, masterPathForType(t)]),
        );

        this._debounceTimers = new Map();
        this._suppressedPaths = new Set();

        await this.ensureMasterFilesExist();
        this.registerInsertCommands();
        this.registerSyncCommands();
        this.registerVaultListeners();

        new Notice(
            `Callout Master Export: tracking [${this.trackedTypes.join(", ")}]`,
        );
    }

    onunload() {
        for (const t of this._debounceTimers.values()) window.clearTimeout(t);
        this._debounceTimers.clear();
        this._suppressedPaths.clear();
    }

    async ensureMasterFilesExist() {
        const adapter = this.app.vault.adapter;

        // Create master folder if configured
        if (MASTER_FOLDER) {
            const folderPath = normalizePath(MASTER_FOLDER);
            const st = await adapter.stat(folderPath);

            if (!st) {
                try {
                    await this.app.vault.createFolder(folderPath);
                } catch (e) {
                    if (!isAlreadyExistsError(e)) throw e;
                }
            } else if (st.type !== "folder") {
                new Notice(
                    `Callout exporter: "${folderPath}" exists but is not a folder. Fix it or set MASTER_FOLDER="" in main.js.`,
                );
                return; // don't crash the plugin
            }
        }

        for (const [, mPath] of this.masterPathsByType.entries()) {
            const st = await adapter.stat(mPath);

            if (st) {
                if (st.type !== "file") {
                    new Notice(
                        `Callout exporter: "${mPath}" exists but is not a file. Rename/remove it so the plugin can use it.`,
                    );
                }
                continue;
            }

            try {
                await this.app.vault.create(mPath, "");
            } catch (e) {
                if (!isAlreadyExistsError(e)) throw e;
            }
        }
    }

    registerInsertCommands() {
        for (const type of this.trackedTypes) {
            const nice = type.charAt(0).toUpperCase() + type.slice(1);
            this.addCommand({
                id: `insert-${type}-callout`,
                name: `Insert ${nice} callout`,
                editorCallback: (editor, view) =>
                    this.insertCallout(editor, type),
            });
        }
    }

    registerSyncCommands() {
        this.addCommand({
            id: "sync-active-file-to-masters",
            name: "Sync active note callouts to master files",
            checkCallback: (checking) => {
                const file = this.app.workspace.getActiveFile();
                if (!file || !isMarkdownFile(file)) return false;
                if (!checking) this.syncFromSource(file).catch(console.error);
                return true;
            },
        });

        this.addCommand({
            id: "rebuild-all-masters",
            name: "Rebuild all master files from vault (tracked callouts)",
            callback: () => this.rebuildAllMasters().catch(console.error),
        });
    }

    registerVaultListeners() {
        this.registerEvent(
            this.app.vault.on("modify", (file) => {
                if (!isMarkdownFile(file)) return;
                if (this._suppressedPaths.has(file.path)) return;
                this.scheduleSync(file.path);
            }),
        );

        this.registerEvent(
            this.app.vault.on("rename", (file, oldPath) => {
                if (!isMarkdownFile(file)) return;
                this.onRename(file, oldPath).catch(console.error);
            }),
        );

        this.registerEvent(
            this.app.vault.on("delete", (file) => {
                if (!isMarkdownFile(file)) return;
                this.onDelete(file.path).catch(console.error);
            }),
        );
    }

    scheduleSync(path) {
        const prev = this._debounceTimers.get(path);
        if (prev) window.clearTimeout(prev);

        const t = window.setTimeout(() => {
            this._debounceTimers.delete(path);
            this.syncPath(path).catch(console.error);
        }, SYNC_DEBOUNCE_MS);

        this._debounceTimers.set(path, t);
    }

    async syncPath(path) {
        const af = this.app.vault.getAbstractFileByPath(path);
        if (!(af instanceof TFile)) return;

        // Is this one of the masters?
        for (const [type, masterPath] of this.masterPathsByType.entries()) {
            if (af.path === masterPath) {
                await this.syncFromMaster(type, af);
                return;
            }
        }

        // Otherwise, source note
        await this.syncFromSource(af);
    }

    async writeFileIfChanged(file, newText) {
        if (!isMarkdownFile(file)) return;
        const oldText = await this.app.vault.cachedRead(file);
        if (oldText === newText) return;

        this._suppressedPaths.add(file.path);
        try {
            await this.app.vault.modify(file, newText);
        } finally {
            window.setTimeout(
                () => this._suppressedPaths.delete(file.path),
                SUPPRESS_MS,
            );
        }
    }

    insertCallout(editor, type) {
        const id = generateId();
        const isTodo = type === "todo";

        // Per Obsidian guidance for structured blocks, keep blank line before and after ^id. :contentReference[oaicite:1]{index=1}
        const calloutStart = `> [!${type}]`;
        const firstLine = isTodo ? `> - [ ] ` : `> - `;
        const snippet = `${calloutStart}\n${firstLine}\n\n^${id}\n\n`;

        const cursor = editor.getCursor();
        editor.replaceRange(snippet, cursor);

        // Place cursor at the start of the item text:
        // "> - [ ] |" or "> - |"
        const lineOffset = 1; // second inserted line
        const chOffset = isTodo ? `> - [ ] `.length : `> - `.length;
        editor.setCursor({ line: cursor.line + lineOffset, ch: chOffset });
    }

    async syncFromSource(file) {
        const trackedTypes = this.trackedTypes;
        if (!trackedTypes.length) return;

        const raw = await this.app.vault.cachedRead(file);
        const { text: patched, callouts } = extractTrackedCallouts(
            raw,
            trackedTypes,
            {
                autoInsertIds: true,
            },
        );

        // If we inserted missing ids, write back the source file first (and continue with patched content).
        if (patched !== raw) {
            await this.writeFileIfChanged(file, patched);
        }

        // Group callouts by type
        const byType = new Map(trackedTypes.map((t) => [t, []]));
        for (const c of callouts) {
            if (byType.has(c.type)) byType.get(c.type).push(c);
        }

        // Update relevant master files *in place* for this one source note.
        for (const [type, list] of byType.entries()) {
            await this.updateMasterForSourceFile(type, file, list);
        }
    }

    async updateMasterForSourceFile(type, sourceFile, calloutsOfType) {
        const masterPath = this.masterPathsByType.get(type);
        if (!masterPath) return;

        const af = this.app.vault.getAbstractFileByPath(masterPath);
        if (!(af instanceof TFile)) return;

        const masterText = await this.app.vault.cachedRead(af);
        const parsed = parseMasterChunks(masterText);
        let { lines, chunks } = parsed;

        // Existing chunks belonging to this source file
        const existing = chunks.filter((c) => c.sourcePath === sourceFile.path);

        const desiredById = new Map();
        for (const c of calloutsOfType) desiredById.set(c.blockId, c);

        const ops = [];

        // Replace or remove existing chunks for this file
        for (const ch of existing) {
            const desired = desiredById.get(ch.blockId);
            if (!desired) {
                // Removed in source → remove in master
                ops.push({ start: ch.start, end: ch.end, insert: [] });
            } else {
                const newChunkLines = buildMasterChunkLines({
                    display: sourceFile.basename,
                    sourcePath: sourceFile.path,
                    blockId: desired.blockId,
                    bodyLines: desired.bodyLines,
                });
                ops.push({
                    start: ch.start,
                    end: ch.end,
                    insert: newChunkLines,
                });
            }
        }

        // Add new chunks that don't exist yet
        const existingIds = new Set(existing.map((c) => c.blockId));
        const additions = [];
        for (const desired of calloutsOfType) {
            if (!existingIds.has(desired.blockId)) {
                additions.push(
                    ...buildMasterChunkLines({
                        display: sourceFile.basename,
                        sourcePath: sourceFile.path,
                        blockId: desired.blockId,
                        bodyLines: desired.bodyLines,
                    }),
                );
            }
        }

        // Apply ops bottom-to-top to preserve indexes
        ops.sort((a, b) => b.start - a.start);
        for (const op of ops) {
            lines.splice(op.start, op.end - op.start, ...op.insert);
        }

        if (additions.length) {
            // Ensure at least one blank line before appending for cleanliness
            if (lines.length && String(lines[lines.length - 1]).trim() !== "")
                lines.push("");
            lines.push(...additions);
        }

        let out = lines.join("\n");
        // Normalize to end with newline (Obsidian-friendly)
        if (!out.endsWith("\n")) out += "\n";

        await this.writeFileIfChanged(af, out);
    }

    async syncFromMaster(type, masterFile) {
        const masterText = await this.app.vault.cachedRead(masterFile);
        const { chunks } = parseMasterChunks(masterText);

        // Group entries by source file to apply multiple updates in one write per file.
        const bySource = new Map();
        for (const ch of chunks) {
            if (!bySource.has(ch.sourcePath)) bySource.set(ch.sourcePath, []);
            bySource.get(ch.sourcePath).push(ch);
        }

        for (const [sourcePath, entries] of bySource.entries()) {
            const af = this.app.vault.getAbstractFileByPath(sourcePath);
            if (!(af instanceof TFile)) continue;

            const srcText = await this.app.vault.cachedRead(af);
            const updated = this.applyMasterEditsToSource(
                srcText,
                type,
                entries,
            );

            if (updated !== srcText) {
                await this.writeFileIfChanged(af, updated);
            }
        }
    }

    applyMasterEditsToSource(sourceText, type, entries) {
        // Parse callouts with IDs but do NOT auto-insert here (avoid surprise edits from master sync).
        const { text, callouts } = extractTrackedCallouts(sourceText, [type], {
            autoInsertIds: false,
        });
        const lines = text.split(/\r?\n/);

        const byId = new Map(callouts.map((c) => [c.blockId, c]));

        // Apply replacements bottom-to-top to preserve line indexes
        const ops = [];
        for (const e of entries) {
            const c = byId.get(e.blockId);
            if (!c) continue;

            // Replace everything between the callout header line and the end of the blockquote
            const newBodyQuoted = quoteBodyLines(e.bodyLines);
            ops.push({
                start: c.startLine + 1,
                end: c.quoteEndLine,
                insert: newBodyQuoted,
            });
        }

        ops.sort((a, b) => b.start - a.start);
        for (const op of ops) {
            lines.splice(op.start, op.end - op.start, ...op.insert);
        }

        return lines.join("\n");
    }

    async rebuildAllMasters() {
        const all = this.app.vault.getMarkdownFiles();
        const masters = new Set(Array.from(this.masterPathsByType.values()));

        // Build full lists per type
        const gathered = new Map(this.trackedTypes.map((t) => [t, []]));

        for (const f of all) {
            if (masters.has(f.path)) continue;

            const raw = await this.app.vault.cachedRead(f);
            const { text: patched, callouts } = extractTrackedCallouts(
                raw,
                this.trackedTypes,
                {
                    autoInsertIds: true,
                },
            );

            if (patched !== raw) await this.writeFileIfChanged(f, patched);

            for (const c of callouts) {
                if (!gathered.has(c.type)) continue;
                gathered.get(c.type).push({
                    display: f.basename,
                    sourcePath: f.path,
                    blockId: c.blockId,
                    bodyLines: c.bodyLines,
                });
            }
        }

        // Write masters
        for (const [type, entries] of gathered.entries()) {
            const mPath = this.masterPathsByType.get(type);
            const af = this.app.vault.getAbstractFileByPath(mPath);
            if (!(af instanceof TFile)) continue;

            // Stable ordering: by source path, then by block id
            entries.sort((a, b) =>
                (a.sourcePath + a.blockId).localeCompare(
                    b.sourcePath + b.blockId,
                ),
            );

            const lines = [];
            for (const e of entries) lines.push(...buildMasterChunkLines(e));
            let out = lines.join("\n");
            if (!out.endsWith("\n")) out += "\n";

            await this.writeFileIfChanged(af, out);
        }

        new Notice("Callout Master Export: rebuilt master files.");
    }

    async onRename(file, oldPath) {
        // Update master links that point at oldPath → new path and display name.
        for (const [type, masterPath] of this.masterPathsByType.entries()) {
            const af = this.app.vault.getAbstractFileByPath(masterPath);
            if (!(af instanceof TFile)) continue;

            const masterText = await this.app.vault.cachedRead(af);
            const { lines, chunks } = parseMasterChunks(masterText);

            const ops = [];
            for (const ch of chunks) {
                if (ch.sourcePath !== oldPath) continue;

                const newChunkLines = buildMasterChunkLines({
                    display: file.basename,
                    sourcePath: file.path,
                    blockId: ch.blockId,
                    bodyLines: ch.bodyLines,
                });

                ops.push({
                    start: ch.start,
                    end: ch.end,
                    insert: newChunkLines,
                });
            }

            if (!ops.length) continue;

            ops.sort((a, b) => b.start - a.start);
            for (const op of ops)
                lines.splice(op.start, op.end - op.start, ...op.insert);

            let out = lines.join("\n");
            if (!out.endsWith("\n")) out += "\n";
            await this.writeFileIfChanged(af, out);
        }
    }

    async onDelete(deletedPath) {
        // Remove chunks referencing deletedPath from all masters.
        for (const [type, masterPath] of this.masterPathsByType.entries()) {
            const af = this.app.vault.getAbstractFileByPath(masterPath);
            if (!(af instanceof TFile)) continue;

            const masterText = await this.app.vault.cachedRead(af);
            const { lines, chunks } = parseMasterChunks(masterText);

            const ops = chunks
                .filter((ch) => ch.sourcePath === deletedPath)
                .map((ch) => ({ start: ch.start, end: ch.end, insert: [] }));

            if (!ops.length) continue;

            ops.sort((a, b) => b.start - a.start);
            for (const op of ops) lines.splice(op.start, op.end - op.start);

            let out = lines.join("\n");
            if (!out.endsWith("\n")) out += "\n";
            await this.writeFileIfChanged(af, out);
        }
    }
};
