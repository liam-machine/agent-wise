# Sample HR/SOP Document Corpus

This folder is the sample document corpus for the **Wiseway Staff Assistant** demo.
The MCP doc-search service (`mcp-doc-search/`) reads these markdown files with its
**local** backend (`WISEWAY_DOC_BACKEND=local`), parses the YAML front-matter, and runs
BM25 search over each document's `title` + body.

It also serves as the **contract** that the real SharePoint HR-AU library will later
mirror: the `category` in front-matter here corresponds to the metadata column / parent
folder that the **graph** backend derives category from in production. Keep the schema
identical so swapping `local` → `graph` requires no change to the role-access logic.

## Front-matter schema

Every document begins with a YAML front-matter block delimited by `---` lines:

```yaml
---
title: Annual Leave Policy
category: hr
source_url: https://contoso.sharepoint.com/sites/YourHRSite/Shared%20Documents/Wiseway-Demo/HR-AU/annual-leave-policy.docx
---
```

| Field | Required | Description |
|---|---|---|
| `title` | yes | Human-readable document title. Indexed for search and shown in citations. |
| `category` | yes | Exactly one of `hr`, `sop`, `safety`, `payroll`. This is the **security gate** — it decides which roles may read the doc. |
| `source_url` | yes | The (url-encoded) SharePoint URL the document will live at in the real HR-AU library. Returned to the model so every answer cites a real-looking link as `[Title](source_url)`. |

The body below the front-matter is realistic Australian logistics HR/SOP prose with
headings and clear, ask-able clauses.

## Categories and role access

Category is the only thing that gates access. The MCP doc-search handler reads the
caller's role from the `X-User-Role` HTTP header, looks it up in
`mcp-doc-search/roles.yaml`, and **filters out any document whose `category` is not
allowed for that role — server-side, before results reach the model.** The model never
sees a disallowed document.

| Role | Allowed categories |
|---|---|
| `warehouse` | `hr`, `sop`, `safety` |
| `driver` | `hr`, `sop`, `safety` |
| `office` | `hr`, `sop` |
| `hr-admin` | `hr`, `sop`, `safety`, `payroll` |

`payroll` is the sensitive category: **only `hr-admin` may read it.**

## Documents in this corpus

| File | Category | Readable by |
|---|---|---|
| `annual-leave-policy.md` | `hr` | warehouse, driver, office, hr-admin |
| `personal-carers-leave.md` | `hr` | warehouse, driver, office, hr-admin |
| `forklift-operation-sop.md` | `sop` | warehouse, driver, office, hr-admin |
| `vehicle-prestart-checklist.md` | `sop` | warehouse, driver, office, hr-admin |
| `loading-dock-safety.md` | `safety` | warehouse, driver, hr-admin (NOT office) |
| `payroll-classifications.md` | `payroll` | hr-admin only |

## Demo behaviour this enables

- **Sam Tran (warehouse)** and **Dee Okafor (driver)** can read leave, SOPs, and safety
  docs, but a payroll question returns "I don't know" (no readable doc matched).
- **Olivia Park (office)** additionally cannot read `loading-dock-safety.md` — a safety
  question returns nothing for her.
- **Hannah Reed (hr-admin)** is the only staff member who can retrieve
  `payroll-classifications.md`.

## Adding or editing documents

1. Add a `.md` file with all three front-matter fields.
2. Set `category` to one of the four allowed values — this alone controls who can read it.
3. Point `source_url` at the matching `…/HR-AU/<file>.docx` path (url-encoded).
4. Restart the doc-search service (or rebuild its container) so the local index re-reads
   the folder.
