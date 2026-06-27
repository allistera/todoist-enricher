# Todoist Enricher 🚀

A Cloudflare Worker application built with **Hono** and **chanfana (formerly cloudflare-2-openapi)** to receive, verify, and process Todoist webhooks, as well as expose an OpenAPI 3.1-compliant REST API for task management.

---

## 🛠️ Tech Stack & Features

*   **Runtime:** [Cloudflare Workers](https://workers.cloudflare.com/) (V8-based, extremely low latency)
*   **Web Framework:** [Hono](https://hono.dev/) (ultrafast, lightweight router)
*   **OpenAPI Integration:** [chanfana](https://chanfana.pages.dev/) (auto-generates OpenAPI 3.1 schemas from TypeScript/Zod definitions)
*   **Validation:** [Zod](https://zod.dev/) (strict request/response type-safety)
*   **Todoist Webhook Verification:** Verifies Todoist webhook payloads using cryptographic SHA-256 HMAC signatures via `SubtleCrypto`.
*   **ChatGPT Task Enrichment:** When a new task with a description is created, it extracts the description and sends it to OpenAI's ChatGPT (`gpt-4o-mini`) to improve readability and generate subtasks if required.
*   **Todoist Integration:** Rewrites the task's title and description using the Todoist REST API v2, and programmatically spawns sub-tasks underneath the parent task.

---

## 📂 Project Structure

Below is an overview of the key files in this project:

*   **[`src/index.ts`](./src/index.ts)**: The primary entry point. Initializes the Hono app, configures the OpenAPI Swagger documentation endpoint, and maps endpoints.
*   **[`src/types.ts`](./src/types.ts)**: Contains shared Zod schemas (such as the standard `Task` schema) and context type bindings.
*   **[`wrangler.jsonc`](./wrangler.jsonc)**: Configuration file for Wrangler and Cloudflare Workers runtime.
*   **Endpoints (`src/endpoints/`)**:
    *   **[`todoistWebhook.ts`](./src/endpoints/todoistWebhook.ts)**: Handles `POST /api/webhooks/todoist`. Performs HMAC verification on the incoming Todoist webhook payload and processes `item:added` events.
    *   **[`taskList.ts`](./src/endpoints/taskList.ts)**: `GET /api/tasks` - List tasks with pagination and status filters.
    *   **[`taskCreate.ts`](./src/endpoints/taskCreate.ts)**: `POST /api/tasks` - Create a task.
    *   **[`taskFetch.ts`](./src/endpoints/taskFetch.ts)**: `GET /api/tasks/:taskSlug` - Fetch a specific task by its slug.
    *   **[`taskDelete.ts`](./src/endpoints/taskDelete.ts)**: `DELETE /api/tasks/:taskSlug` - Delete a task by its slug.

---

## 🚀 Getting Started

### 1. Setup & Installation

Clone this repository, then install the dependencies using `pnpm` (or `npm`/`yarn`):

```bash
pnpm install
```

### 2. Configure Environment Variables

The worker requires three environment variables to function correctly:
1. `TODOIST_CLIENT_SECRET`: Your Todoist developer application's client secret, used to verify HMAC webhook signatures.
2. `TODOIST_API_TOKEN`: Your Todoist Personal API Token, used to edit tasks and create sub-tasks via the REST API. Find this in **Settings > Integrations > Developer** in the Todoist app.
3. `OPENAI_API_KEY`: Your OpenAI API key, used to connect to ChatGPT for task enrichment.

**For local development:**
Copy `.dev.vars.example` to `.dev.vars` and fill in the values:
```env
TODOIST_CLIENT_SECRET=your_todoist_client_secret
TODOIST_API_TOKEN=your_todoist_personal_api_token
OPENAI_API_KEY=your_openai_api_key
```

**For production deployment:**
Provision the secrets in your Cloudflare environment:
```bash
npx wrangler secret put TODOIST_CLIENT_SECRET
npx wrangler secret put TODOIST_API_TOKEN
npx wrangler secret put OPENAI_API_KEY
```

### 3. Run Locally

Start the local development server:

```bash
pnpm run dev
```

The server will start by default at `http://localhost:8787/`.
Open `http://localhost:8787/` in your browser to view the **Swagger UI** generated automatically by `chanfana` and interact directly with the endpoints.

---

## 🛰️ API Endpoints

### OpenAPI Managed Endpoints
*   `GET /api/tasks` — List tasks (supports query filtering for `page` and `isCompleted`).
*   `POST /api/tasks` — Create a task (validates payload against the `Task` schema).
*   `GET /api/tasks/:taskSlug` — Fetch a task.
*   `DELETE /api/tasks/:taskSlug` — Delete a task.

### Todoist Webhook Endpoint
*   `POST /api/webhooks/todoist`
    *   Expects header: `X-Todoist-Hmac-SHA256`
    *   Expects webhook event: `item:added`
    *   Verifies HMAC signature matching `TODOIST_CLIENT_SECRET`.

---

## 🛠️ Scripts & Commands

| Command | Purpose |
| :--- | :--- |
| `pnpm run dev` | Runs the local development server with live reload |
| `pnpm run deploy` | Deploys the application live to Cloudflare Workers |
| `pnpm run cf-typegen` | Generates TypeScript types (`worker-configuration.d.ts`) based on bindings |
| `pnpm run lint` | Lints the codebase using ESLint |
| `pnpm run lintfix` | Automatically fixes simple ESLint issues |
| `pnpm test` | Runs the tap test suite |
