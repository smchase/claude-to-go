# Claude Code Instructions for claude-to-go

## After Making Changes

### Client-side changes (public/app.js, public/index.html, etc.)
Immediately update the cache buster version in `public/index.html`:
```html
<script src="app.js?v=XX"></script>
```
Increment the version number so the user can test changes right away.

### Server-side changes (server.js)
Immediately restart the systemd service so the user can test changes:
```bash
sudo systemctl restart claude-to-go
```

These should be done at each step of a task, not just when the task is complete.

## Committing Changes

Only commit and push when a task or goal is complete, not for work-in-progress. Once we finish working on a particular issue, automatically commit and push the changes.
