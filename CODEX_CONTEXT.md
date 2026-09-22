# Codex Context

This file is shared working memory for Codex sessions in this repository. Read it near the start of future work, update it when durable project context changes, and keep it concise.

## User Preferences

- The user wants repository context remembered in a Markdown file.
- Prefer direct implementation when the request is clear.
- Do not touch `.env` values unless explicitly asked.

## Project Snapshot

- Project: MarkMate, an AI-powered PDF assignment marking and educational content generation platform.
- Stack: Node.js/Express backend, React/Vite/TypeScript frontend, SQLite/MySQL/PostgreSQL via `DATABASE_URL`.
- Main project guide: `CLAUDE.md`.
- Subpath deployment details: `README_SUBPATH.md`.

## Working Notes

- Current context file created on 2026-05-31.
- Existing uncommitted change observed before this file was added: `.claude/settings.json`.
- When making code changes, check existing conventions first and keep edits narrowly scoped.
- 2026-05-31: Assignment uploads and marking now support DOCX Word documents alongside PDFs. DOCX marking uses extracted text; inline annotation remains PDF-only.
- 2026-05-31: DOCX marking can produce a commented Word document output. Native Word comments are inserted into `.docx` files; result downloads can generate the commented DOCX on demand if needed.
- 2026-05-31: Marking assessment types include Assignment, Test, Exam, Project Proposal, Treatise, and Thesis. Backend document type values include `exam` and `project_proposal` (`proposal` remains an alias).
- 2026-05-31: Admin dashboard exposes role impersonation for active approved lecturer/student accounts. Backend impersonation remains admin-only and blocks management/admin targets.
- 2026-05-31: Source-code uploads are supported for marking. Common code/text extensions such as `.py`, `.js`, `.ts`, `.java`, `.cpp`, `.sql`, `.sh`, `.html`, `.css`, `.json`, and `.yaml` are extracted as text and marked with document type `code`.

## Update Protocol

- Add durable decisions, environment assumptions, active feature status, and recurring user preferences here.
- Do not store secrets, API keys, passwords, tokens, private personal data, or full `.env` contents.
- Prefer short dated bullets over long narrative.
