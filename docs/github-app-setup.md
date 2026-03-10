# GitHub App Setup

Actuarius uses a GitHub App for authenticated access to repositories. This is the preferred authentication method over a personal `GH_TOKEN`.

## Create the GitHub App

1. Go to **GitHub Settings > Developer settings > GitHub Apps > New GitHub App**
   - Direct link: https://github.com/settings/apps/new

2. Fill in the basics:
   - **Name**: e.g. `actuarius-bot` (must be globally unique on GitHub)
   - **Homepage URL**: your repo URL or any valid URL
   - **Webhook**: uncheck **Active** — Actuarius does not use webhooks

3. Set **Repository permissions**:
   - **Contents**: Read & Write (clone, fetch, push)
   - **Issues**: Read & Write (for `/bug` and `/issue` commands)
   - **Pull requests**: Read & Write (if you want the bot to create PRs)
   - **Metadata**: Read-only (required, auto-selected)

4. Under **Where can this GitHub App be installed?**, select **Only on this account**.

5. Click **Create GitHub App**. Note the **App ID** shown on the resulting page.

## Generate a private key

1. On the app settings page, scroll to **Private keys**.
2. Click **Generate a private key**.
3. A `.pem` file will download — keep this safe.

## Install the app on your repositories

1. On the app settings page, click **Install App** in the left sidebar.
2. Choose your GitHub account.
3. Select **Only select repositories** and pick the repos Actuarius should access.
4. After installing, note the **Installation ID** from the URL:
   `https://github.com/settings/installations/<INSTALLATION_ID>`

## Configure Actuarius

Add the following to your `.env`:

```env
GITHUB_APP_ID=<App ID from step 5 above>
GITHUB_APP_INSTALLATION_ID=<Installation ID from the install URL>
```

For the private key, choose one of:

**Option A — Base64-encoded (recommended for Docker/CI):**

```bash
# Linux/macOS
base64 -w 0 < your-app-name.pem

# PowerShell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("your-app-name.pem"))
```

```env
GITHUB_APP_PRIVATE_KEY_B64=<base64 output>
```

**Option B — Raw PEM value:**

```env
GITHUB_APP_PRIVATE_KEY=-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----
```

Note: use literal `\n` for newlines when setting the value in a `.env` file.

## Git commit identity

When using GitHub App auth, Actuarius automatically derives its git commit identity from the app metadata:

- **User**: `<app-slug>[bot]` (e.g. `actuarius-bot[bot]`)
- **Email**: `<app-id>+<app-slug>[bot]@users.noreply.github.com`

To override this, set `GIT_USER_NAME` and `GIT_USER_EMAIL` in your `.env` (both must be provided together).

## Fallback: personal access token

If you don't want to use a GitHub App, you can set `GH_TOKEN` instead:

```env
GH_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Use a fine-grained personal access token with minimal repository permissions. This is less secure than a GitHub App because the token has broader scope tied to your personal account.

## Adding repositories later

To give Actuarius access to additional repos after initial setup:

1. Go to https://github.com/settings/installations
2. Click **Configure** next to the Actuarius app installation
3. Under **Repository access**, add the new repositories
