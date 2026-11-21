# One Brain export format

A workspace export is a zip of everything you can read in a One Brain workspace at the moment you ask for it, as plain text. You can read it without One Brain: every entry is UTF-8 text, either Markdown (or whatever the file held) or JSON. This document, like the format it describes and the `onebrain` CLI, is MIT-licensed.

## Getting one

`GET /v1/workspaces/<workspace>/export` with a person's sign-in token returns the zip as `<workspace>-export.zip` (`Content-Type: application/zip`, `Content-Disposition: attachment`), where `<workspace>` is the workspace slug.

- Any person in the workspace can export. An agent key gets 403 `forbidden`.
- A workspace whose key is revoked answers 423 `key_revoked`. A revoke during a download breaks it off.
- Two exports run at once per server. A third answers 429 `too_many_requests` with `Retry-After: 30`.
- A download is broken off, and the zip is incomplete, when its client takes less than 64 KB in 40 to 60 seconds, or when it has run for 6 hours.
- Each export is recorded in the workspace's audit log as `workspace.export` when it starts, with the four counts at that moment.

"Everything you can read" follows the same rules as every other read in One Brain: open folders by your workspace role, restricted folders by grant, and your own private files under `me/`. Two people who export the same workspace can get different zips.

## Layout

```
<workspace>-export.zip
  manifest.json
  files/<path>                     the current text of each shared file you can read
  private/<owner email>/<path>     the current text of each private file you can read; <path> starts with me/
  memories.jsonl                   one memory per line
  sources.jsonl                    one source per line
  improvements.jsonl               one improvement per line
```

Dates everywhere are ISO 8601 in UTC with milliseconds, like `2026-11-13T09:30:00.000Z`. Ids are UUIDs. The manifest carries no format version number yet.

## `manifest.json`

One JSON object, written with two-space indentation and a final newline.

| Field | Type | Meaning |
|---|---|---|
| `workspace` | string | The workspace slug |
| `exportedAt` | string | When the export was made |
| `counts` | object | How many of each the zip holds: `files`, `memories`, `sources`, `improvements` |

`counts.files` counts shared and private files together.

## `files/<path>`

One entry per file that is not deleted, holding the text of its current version. `<path>` is the file's path in the workspace, with names and case as they were written: each segment matches `[A-Za-z0-9][A-Za-z0-9._-]*`. Folders appear only as the folders of the files in them, so an empty folder is not in the zip.

A skill is a folder whose `SKILL.md` follows the Agent Skills format. Its files (`SKILL.md`, `REFERENCE.md`, `scripts/...`) are files like any other, at their paths, so a skill in the export is ready to copy into an agent's skills folder.

Only the current version is exported, and the zip does not record its version number.

## `private/<owner email>/<path>`

Private files live under `me/`. Every person has their own `me/`, so two people can each have a `me/notes.md`, and the owner's email keeps them apart: `private/a@example.com/me/notes.md`. When the owner has no email, the folder is named by the owner's id instead.

A private file belongs to its owner and to nobody else, workspace admins included, so this folder holds the private files of the person who exported.

## `memories.jsonl`

One JSON object per line, each line ending in a newline; the file is empty when there are no memories. Every memory you can read is there, whatever its status.

| Field | Type | Meaning |
|---|---|---|
| `id` | string | The memory's id |
| `text` | string | The memory |
| `folder` | string or null | The path of the folder it belongs to; null when it has no folder |
| `visibility` | `workspace` or `private` | The visibility of its folder; `private` when it has no folder |
| `status` | string | `unreviewed`, `accepted`, `rejected` or `retired` |
| `kind` | string or null | What the learning loop took it to be: `fact`, `decision`, `preference`, `procedure` or `correction`; null for a memory a person or an agent saved |
| `validFrom` | string | When it became true |
| `validTo` | string or null | When it stopped being true; null while it still holds |
| `supersedesId` | string or null | The id of the memory this one replaces |
| `createdAt` | string | When it was saved |

## `sources.jsonl`

The raw items memories and improvements cite: an agent's save, a captured AI session, an upload, an import. Same line format as `memories.jsonl`.

| Field | Type | Meaning |
|---|---|---|
| `id` | string | The source's id |
| `kind` | string | `agent_save`, `session`, `upload` or `import` today; new kinds can appear later |
| `folder` | string or null | The path of the folder it landed in; null when it has none (private to a person) |
| `externalRef` | string or null | Where it came from outside One Brain, for example `claude-code:<session id>` for a captured session |
| `occurredAt` | string or null | When it happened, when known |
| `createdAt` | string | When it was stored |
| `content` | string | Its full text |

## `improvements.jsonl`

Proposed changes to files, in every status. Same line format.

| Field | Type | Meaning |
|---|---|---|
| `id` | string | The improvement's id |
| `path` | string | The file it changes |
| `status` | string | `pending`, `accepted`, `dismissed` or `superseded` |
| `baseVersion` | number | The file version it was written against |
| `title` | string | What it changes, as an instruction |
| `why` | string | Why |
| `newBody` | string | The whole proposed text of the file |
| `createdAt` | string | When it was proposed |

## Redaction

One Brain removes secrets and personal data before it stores anything, so the export holds `[redacted:secret]`, `[redacted:email]`, `[redacted:phone]` or `[redacted:card]` where the original had one. The original values were never stored and cannot be exported.

## What an export does not hold

- Older versions of files. Read a file's history in One Brain itself.
- The audit log. Its rows hold ids, kinds and counts only, and are read and verified in One Brain.
- Members, groups, agents, keys, grants and folder settings (open or restricted, the write policy).
- Deleted files.
- Search data (word stems and embeddings). It is derived from the content and rebuilt from it.
- Skill releases (which file versions made up each release of a skill). Each skill file's current version is under `files/`.
- Who wrote a file or a memory, which source a memory came from, an improvement's citations, and who proposed or decided it.
- A memory's evidence: the passages of sessions and uploads the learning loop quoted when it drew the memory from them. The sources themselves are in `sources.jsonl`.

## Reading an export without One Brain

```bash
unzip kenso-export.zip -d kenso
cat kenso/manifest.json
ls -R kenso/files
jq -r 'select(.status == "accepted") | .text' kenso/memories.jsonl
jq -r 'select(.status == "pending") | "\(.path): \(.title)"' kenso/improvements.jsonl
```

```python
import json
import zipfile

with zipfile.ZipFile("kenso-export.zip") as export:
    manifest = json.loads(export.read("manifest.json"))
    memories = [json.loads(line) for line in export.read("memories.jsonl").decode().splitlines() if line]
    files = {name[len("files/"):]: export.read(name).decode() for name in export.namelist() if name.startswith("files/")}
```

The export and this document change together.
