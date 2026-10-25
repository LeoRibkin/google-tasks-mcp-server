# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0] - 2026-10-25

### Added

- First public release.
- Nine MCP tools for Google Tasks: `list_tasklists`, `create_tasklist`, `list_tasks` (filter by list, status and due-date range), `get_task`, `create_task` (including subtasks), `update_task`, `complete_task`, `delete_task` and `move_task`.
- A remote MCP endpoint (stateless Streamable HTTP) for Claude custom connectors, protected by an unguessable secret in the URL path.
- A private setup page with a live connection test, and a Google OAuth 2.0 sign-in (offline access) with PKCE, signed state and browser binding. The refresh token is shown once, to be stored as a Vercel environment variable.
- Exact due-date filtering, even though Google's own due-date filter doesn't line up with calendar days.
- Error logging that redacts tokens and secrets.
- One-click deployment to Vercel (Deploy button), CI (lint, tests, dependency audit, gitleaks), CodeQL and Dependabot.
