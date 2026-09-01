# dsh-plugin-noticeme

Notify me when DSH needs me: desktop notification (with tab-title fallback) when an
approval prompt or an ask-user-question card appears while the page is in the background.   

<img width="566" height="285" alt="image" src="https://github.com/user-attachments/assets/60c1bfe1-399d-47bc-8be8-6db6a3f31f35" />


## Install

```sh
dsh plugin --profile web add link:/absolute/path/to/this/pkg
# published form:
dsh plugin add github:lw-storm/dsh-plugin-noticeme
```

Restart DSH after installing. On first page load the browser asks for notification
permission — allow it.

## Behavior

- Watches `approval/request` (approval prompts) and `tools/result` for
  `ask_user_question` (question cards) on the host.
- Host keeps a short-lived queue, exposed at `GET /dsh-noticeme/pending`
  (same-origin only). Reading drains the queue: each item is notified once.
- Client polls every 3 s. While the page is visible nothing is shown; while
  hidden, a desktop `Notification` is raised (click → focus the page). If the
  Notification permission is unavailable, the tab title is prefixed with
  `⚠ 需要你确认 · ` and restored when the page becomes visible again.

## Files

- `lib/index.js` — host entry (ESM, Node)
- `client/client.js` — browser entry (hand-written ModuleLoader bundle, no build step)
- `cordis.patch.yml` — profile layer insertion

## License

MIT
