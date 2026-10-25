# Google Tasks MCP Server for Claude

Let Claude see and manage your Google Tasks (list, create, update, complete, move and delete tasks) through a small private server that **you** deploy to your own free Vercel account.

[![CI](https://github.com/LeoRibkin/google-tasks-mcp-server/actions/workflows/ci.yml/badge.svg)](https://github.com/LeoRibkin/google-tasks-mcp-server/actions/workflows/ci.yml)
[![CodeQL](https://github.com/LeoRibkin/google-tasks-mcp-server/actions/workflows/codeql.yml/badge.svg)](https://github.com/LeoRibkin/google-tasks-mcp-server/actions/workflows/codeql.yml)

> [!WARNING]
> **Never share your connector URL – it is the key to your data.**
> Anyone who has it can read, change and delete your Google Tasks. Keep it in a password manager, and never paste it into chats, emails, screenshots or GitHub issues.

## Contents

- [What it does](#what-it-does)
- [Security model](#security-model)
- [What you need](#what-you-need)
- [Setup](#setup)
- [Troubleshooting](#troubleshooting)
- [Updating safely](#updating-safely)
- [Configuration reference](#configuration-reference)
- [For developers](#for-developers)
- [License](#license)

## What it does

Once it's connected, you can ask Claude things like:

- "What's on my task list for this week?"
- "Add 'renew passport' to my tasks, due next Friday."
- "Mark the dentist task as done and move the gym task to my Personal list."

### Tools

| Tool | What it does | Parameters |
|---|---|---|
| `list_tasklists` | Lists all your task lists with their IDs. The default list is marked. | none |
| `create_tasklist` | Creates a new task list. | `title` |
| `list_tasks` | Lists tasks in one list, or in all lists, filtered by status and due date, in the same order as the Google Tasks app (subtasks follow their parent). | `tasklist_id`, `status`, `due_from`, `due_to`, `max_results` |
| `get_task` | Gets one task with all its details. | `task_id`, `tasklist_id` |
| `create_task` | Creates a task, or a subtask of another task. | `title`, `notes`, `due`, `tasklist_id`, `parent_task_id`, `previous_task_id` |
| `update_task` | Changes a task's title, notes, due date and/or status. Only the fields you pass change. | `task_id`, `tasklist_id`, `title`, `notes`, `due`, `status` |
| `complete_task` | Marks a task as completed. | `task_id`, `tasklist_id` |
| `delete_task` | Permanently deletes a task. Claude is told to ask you first. | `task_id`, `tasklist_id` |
| `move_task` | Reorders a task, makes it a subtask (or a top-level task again), or moves it to another list. | `task_id`, `tasklist_id`, `parent_task_id`, `previous_task_id`, `destination_tasklist_id` |

| Parameter | Meaning |
|---|---|
| `tasklist_id` | A list ID from `list_tasklists`. Leave it out to use your default list. `list_tasks` also accepts `all`, to search every list. |
| `task_id` | A task ID from `list_tasks`, `get_task` or `create_task`. |
| `title` | The task or list name. |
| `notes` | Free-text details. With `update_task`, an empty value clears the notes. |
| `due` | A due date in `YYYY-MM-DD` form. Google Tasks stores the date only, not a time. With `update_task`, `none` removes the due date. |
| `status` | For `list_tasks`: `incomplete` (the default), `completed` or `all`. For `update_task`: `completed`, or `incomplete` to reopen a task. |
| `due_from`, `due_to` | Only tasks due on or after / on or before these dates (`YYYY-MM-DD`, inclusive). Tasks without a due date aren't returned when you use these. |
| `max_results` | The maximum number of tasks to return: 1 to 500, default 100. |
| `parent_task_id` | Makes the task a subtask of this task (in the same list). Leave it out of `move_task` to make the task top-level again. |
| `previous_task_id` | Puts the task right after this sibling. Leave it out to put the task first. |
| `destination_tasklist_id` | `move_task` only: moves the task into this other list. |

## Security model

- **Single-user and self-hosted.** You deploy your own copy to your own Vercel account. It serves exactly one Google account: yours. Nobody else, including the authors of this repository, can reach your deployment or your data.
- **The secret URL is the key.** Claude talks to `https://<your-app>/tasks/<TASKS_PATH_SECRET>/mcp`. Every private page (the MCP endpoint, the setup page and the connect button) lives under that unguessable secret. Any other path, or a wrong secret, gets a plain `Not found`. There is no separate login, so anyone with the full URL can read and change your tasks. If the URL ever leaks, set a new `TASKS_PATH_SECRET` in Vercel and redeploy. The old URL stops working at once. Then update the URL in Claude.
- **Google Tasks only.** The server asks Google for exactly one permission, `https://www.googleapis.com/auth/tasks`, which covers Google Tasks and nothing else: no Gmail, Calendar, Drive or contacts.
- **What data is touched.** Only your task lists and tasks, and only when you ask Claude to read or change them. Nothing is copied or stored by the server.
- **What is stored.** Only your Google refresh token, which you save yourself as a **Sensitive** environment variable in your own Vercel account (encrypted by Vercel, and not readable after saving). Short-lived access tokens are kept in memory only.
- **What is never logged.** This code never writes tokens, client secrets, the path secret or your task data to logs. Error messages are logged with anything that looks like a token replaced by `[redacted]`. Note that Vercel's own request logs, visible only inside your Vercel account, show request paths, and those include your path secret. That's one more reason to protect your Vercel account with two-factor authentication and not to forward logs to services you don't trust.
- **Hardened sign-in.** Connecting your Google account uses OAuth 2.0 with PKCE (S256), a signed `state` that expires after 15 minutes, and a `__Host-` cookie that ties the sign-in to the browser that started it. Pages are sent with `no-store`, `noindex` and a strict Content-Security-Policy.
- **What it can't protect against.** Someone who has your connector URL, or access to your Vercel or Claude account.

## What you need

- A **Google account** that uses Google Tasks.
- A free **GitHub** account. The Deploy button copies this project into your account.
- A free **Vercel** account. The Hobby plan is enough.
- A **Claude** account that can add custom connectors (**Settings → Connectors**).
- About 25 minutes. No coding.

## Setup

### Step 1: Prepare your path secret

This is a long random password that becomes part of your private connector URL. Use **only letters and digits** (no symbols), at least 32 characters. Any of these works:

- Your password manager's generator, with symbols turned off and a length of 40.
- On a Mac or Linux, in Terminal: `openssl rand -hex 24`
- On Windows, in PowerShell: `$b = New-Object byte[] 24; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); -join ($b | % { $_.ToString('x2') })`

Save it in your password manager.

### Step 2: Deploy to Vercel

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FLeoRibkin%2Fgoogle-tasks-mcp-server%2Ftree%2Fv1.0.0&project-name=google-tasks-mcp-server&repository-name=google-tasks-mcp-server&env=TASKS_PATH_SECRET&envDescription=TASKS_PATH_SECRET%3A%20a%20long%20random%20secret%20%28letters%20and%20digits%20only%2C%2032%2B%20characters%29%20that%20becomes%20part%20of%20your%20private%20connector%20URL.&envLink=https%3A%2F%2Fgithub.com%2FLeoRibkin%2Fgoogle-tasks-mcp-server%23step-1-prepare-your-path-secret)

1. Click **Deploy with Vercel** above. Sign in to Vercel (or create a free account), and connect your GitHub account if asked.
2. Under **Create Git Repository**, keep the name `google-tasks-mcp-server`. If you see **Create private Git Repository**, leave it ticked. Vercel copies release **v1.0.0** of this project into your own GitHub account, and your deployment is built only from that copy.
3. Fill in the environment variable `TASKS_PATH_SECRET` with your path secret from Step 1.
4. Click **Deploy** and wait about a minute, until Vercel congratulates you.
5. Click **Continue to Dashboard**. Under **Domains**, note your address, for example `google-tasks-mcp-server-abc123.vercel.app`. In the rest of this guide, `<your-app>` means this address.

### Step 3: Open your private setup page

Open `https://<your-app>/tasks/<your path secret>/setup` and bookmark it. Keep it private, like the connector URL. The page shows a checklist, with **Copy** buttons for the values you need next.

### Step 4: Create a Google Cloud project and turn on the Tasks API

1. Go to <https://console.cloud.google.com/projectcreate> and sign in with your Google account. Name the project, for example `Claude Tasks Connector`, and click **Create**. Make sure the project picker at the top-left shows your new project in every step below.
2. Open <https://console.cloud.google.com/apis/library/tasks.googleapis.com> and click **Enable**. If the button says **Manage**, the API is already on.

### Step 5: Set up Google's sign-in screen

1. Open <https://console.cloud.google.com/auth/overview> and click **Get started**.
2. **App information:** enter an app name (for example `Claude Tasks Connector`) and choose your email as the support email. Click **Next**.
3. **Audience:** choose **External** and click **Next**.
4. **Contact information:** enter your email and click **Next**.
5. **Finish:** tick the box to agree to the Google API Services User Data Policy, then click **Continue** and **Create**.
6. Open <https://console.cloud.google.com/auth/branding>. Under **App domain**, fill in:
   - **Application home page:** `https://<your-app>`
   - **Application privacy policy link:** `https://<your-app>/privacy`
   - **Application terms of service link:** `https://<your-app>/terms`
7. Under **Authorized domains**, click **Add domain** and enter `<your-app>` (for example `google-tasks-mcp-server-abc123.vercel.app`). Don't upload a logo, because that triggers a review by Google. Click **Save**.

### Step 6: Allow Tasks access and publish the app

1. Open <https://console.cloud.google.com/auth/scopes> (**Data Access**) and click **Add or remove scopes**.
2. In the **Filter** box, type `tasks`. Tick the scope ending in **/auth/tasks**, described as "Create, edit, organize, and delete all your tasks". (Not the one ending in `tasks.readonly`.) Click **Update**, then **Save**.
3. Open <https://console.cloud.google.com/auth/audience>. Under **Publishing status**, click **Publish app**, then **Confirm**. The status should now say **In production**.

> [!IMPORTANT]
> Don't skip publishing. While an app is in **Testing** mode, Google expires its refresh tokens after **7 days**, and the connector would stop working every week. Google may say the app needs verification. That's only required if other people use your app; you can use an unverified app yourself.

### Step 7: Create the OAuth client and save it in Vercel

Google shows the client secret only once, so keep Google's window open until both values are saved in Vercel.

1. Open <https://console.cloud.google.com/auth/clients> and click **Create client**.
2. **Application type:** **Web application**. **Name:** anything, for example `Claude connector`.
3. Under **Authorized redirect URIs**, click **Add URI** and paste `https://<your-app>/oauth/google/callback` (it's on your setup page). Leave *Authorized JavaScript origins* empty.
4. Click **Create**. A window shows your **Client ID** and **Client secret**.
5. In a second browser tab, open your Vercel project, then **Settings** → **Environment Variables**:
   - Add `GOOGLE_CLIENT_ID`, with the Client ID as its value.
   - Add `GOOGLE_CLIENT_SECRET`, with the Client secret as its value, and turn **Sensitive** on.
   - Keep the environments **Production** and **Preview**, and click **Save**.
6. Redeploy so the server picks them up: open **Deployments**, click **⋯** next to the newest deployment, and choose **Redeploy**.

If you closed Google's window before copying the secret: open the client in the **Clients** list, click **Add secret**, and use the new one.

### Step 8: Connect your Google account

1. Reload your setup page and click **Connect Google account**. Do the whole step in one browser, within 15 minutes.
2. Choose your Google account. Google warns that it **hasn't verified this app**. That's expected for a personal app: click **Advanced**, then **Go to … (unsafe)**.
3. Tick **Create, edit, organize, and delete all your tasks**, then click **Continue**.
4. You'll land on a page that says **"✓ Google account connected"**, with a test result and a long value: your **refresh token**. Treat it like a password.

### Step 9: Save the refresh token in Vercel

1. Click **Copy** next to the refresh token.
2. In Vercel, add the environment variable `GOOGLE_REFRESH_TOKEN` with this value, turn **Sensitive** on, keep **Production** and **Preview**, and click **Save**.
3. Redeploy, as in Step 7.
4. Reload your setup page. Every item should now be green, ending with **Connection test passed**.

### Step 10: Add the connector in Claude

1. In Claude, open **Settings → Connectors** and click **Add custom connector**.
2. **Name:** `Google Tasks`. **URL:** `https://<your-app>/tasks/<your path secret>/mcp`
3. Leave the advanced settings empty and click **Add**. There's no sign-in step, because the secret in the URL is what protects it.
4. In a chat, make sure the connector is switched on in the tools menu. Then ask: *"List my task lists."*

## Troubleshooting

Start with your setup page: every red item says what's wrong and how to fix it.

| Problem | What to do |
|---|---|
| **The connector stops working after about 7 days** ("refresh token was revoked or expired") | Your Google app is still in **Testing** mode, where Google expires refresh tokens after 7 days. Publish it (Step 6.3), then click **Reconnect Google account** on the setup page, replace `GOOGLE_REFRESH_TOKEN` in Vercel with the new value, and redeploy. |
| **"Refresh token was revoked or expired" in a published app** | The token was revoked (for example, you removed the app at <https://myaccount.google.com/connections> or changed your password), or it wasn't used for 6 months. Reconnect, replace `GOOGLE_REFRESH_TOKEN`, and redeploy. |
| **Error 401, or "Invalid Credentials"** | The server automatically retries once with a fresh access token. If the error stays, reconnect as above. |
| **Error 403, or "The Google Tasks API is not enabled"** | Turn on the Tasks API (Step 4.2), wait a minute, and try again. |
| **Error 403, or "does not include permission to manage tasks"** | Reconnect, and tick the Tasks checkbox on Google's permission screen. |
| **"Tasks permission missing" after signing in** | You didn't tick the Tasks checkbox. Click **Connect Google account** again and tick it. |
| **"No refresh token"** | Remove the app at <https://myaccount.google.com/connections>, then connect again. |
| **"Google rejected GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET"** | Check both values in Vercel. Google deletes OAuth clients that haven't been used for about 6 months. If yours is gone, create a new one (Step 7). |
| **Google shows "Error 400: redirect_uri_mismatch"** | The authorized redirect URI must exactly match the one on your setup page: `https://<your-app>/oauth/google/callback`. |
| **"Access blocked: … has not completed the Google verification process"** | The app is in Testing mode and your account isn't a test user. Publish the app (Step 6.3). |
| **"Link expired" after signing in** | Start again from the setup page, in the same browser, and finish within 15 minutes. |
| **The setup page or connector URL says `Not found`** | The secret in the URL must exactly match `TASKS_PATH_SECRET`. Open `https://<your-app>/`: it tells you if the secret is missing or unusable. Redeploy after changing any environment variable. |
| **"Google Tasks rate limit reached" (error 429)** | Wait a minute and try again. |
| **Claude can't connect** | Use your production address (`https://<your-app>`), not the address of a single deployment, and check that the URL ends in `/mcp`. In Vercel, check that the newest deployment is **Ready**. |

## Updating safely

**Your deployment never updates itself.** The Deploy button copied one specific release into your own GitHub account, and Vercel builds only from that copy. Nothing pushed to this repository later can reach your deployment unless you choose to bring it in.

When a new version appears on the [Releases page](https://github.com/LeoRibkin/google-tasks-mcp-server/releases):

1. Read its release notes and [CHANGELOG.md](CHANGELOG.md).
2. Review exactly what changed: `https://github.com/LeoRibkin/google-tasks-mcp-server/compare/<your version>...<new version>` (for example `.../compare/v1.0.0...v1.1.0`).
3. Only if you're happy with it, update your copy:
   - **Without coding:** download the release's **Source code (zip)** and unzip it. In your copy on GitHub, use **Add file → Upload files** to upload all the files, then commit. Vercel redeploys automatically from your copy.
   - **With git:** in your copy, run `git fetch https://github.com/LeoRibkin/google-tasks-mcp-server.git tag <new version>`, then `git checkout <new version> -- .`, then commit.
4. Open your setup page and check that everything is still green.

Rules of thumb:

- Deploy a **release tag** (like `v1.0.0`) or the **full commit SHA** shown on that release, never the moving `main` branch.
- **Don't** connect your Vercel project directly to this repository, and don't turn on automatic fork syncing. Either one would let any future push, including a malicious one, deploy to you automatically.
- If your own tools pin a commit SHA, check that what was checked out really is that commit (`git rev-parse HEAD`).

**Why this matters.** The [Plugin4Shell](https://www.air.security/blog-posts/plugin4shell) research showed how a trusted plugin repository can turn malicious after it has earned users' trust, and how background auto-updates then deliver the new code to every user without anyone clicking anything. That even happened to "pinned" versions, in tools that never checked what they had actually downloaded. A pinned, reviewed version protects you even if this repository is ever compromised. A compromised repository can't change the code you're already running, releases here are immutable (their tags can't be moved to different code), and you see every change before it reaches your data.

## Configuration reference

| Variable | Required | What it is |
|---|---|---|
| `TASKS_PATH_SECRET` | yes | Long random string: letters, digits, `-` and `_` only; at least 16 characters, 32 or more recommended. Part of every private URL. |
| `GOOGLE_CLIENT_ID` | yes | From your Google Cloud OAuth client. |
| `GOOGLE_CLIENT_SECRET` | yes | From your Google Cloud OAuth client. Mark it **Sensitive** in Vercel. |
| `GOOGLE_REFRESH_TOKEN` | yes | Shown once after you connect your Google account on the setup page. Mark it **Sensitive** in Vercel. |
| `PUBLIC_BASE_URL` | no | Only for a custom domain, for example `https://tasks.example.com`. Defaults to your project's production address. |
| `VERCEL_DASHBOARD_URL` | no | Your project's Vercel dashboard address (for example `https://vercel.com/<team>/<project>`). If set, the setup page links straight to your environment variables. |

All configuration comes from environment variables; see [.env.example](.env.example). Nothing is hard-coded.

## For developers

- Node.js 22 with ES modules, and no build step. One Vercel function (`api/index.js`) serves everything: `lib/app.js` routes requests, `lib/tasks.js` holds the Google client, MCP tools and setup pages, and `lib/mcp.js` runs a stateless MCP Streamable HTTP endpoint (JSON responses, POST only).
- Run `npm ci`, `npm run lint` and `npm test`. The tests use Node's built-in test runner and a simulated Google API, with no network access or real accounts.
- Dependencies are pinned to exact versions with a committed `package-lock.json`, and `.npmrc` turns off dependency install scripts.
- Please report security problems privately, as described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE). This project is not affiliated with or endorsed by Google, Vercel or Anthropic. Google Tasks is a trademark of Google LLC.
