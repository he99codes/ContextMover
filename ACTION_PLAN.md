### Action Plan: ContextMover Extension Rehabilitation

### My Requirements

To efficiently execute this action plan, I will need the following from you:

1.  **Approval to Run Commands:** I will need your approval to run commands, specifically the `pnpm run build` command, to apply fixes like the `web-tree-sitter` update. I will always ask for permission before executing any command.

2.  **Access to Web Pages:** For Phase 3 (Repairing Platform Scrapers), I will need to ask you to navigate to the specific LLM websites (e.g., `chat.openai.com`, `gemini.google.com`). I do not have direct access to a web browser, so I will rely on you to open the pages so my tools can analyze the DOM.

3.  **Testing and Verification:** After I implement a fix, I will need you to test the functionality and provide new logs so I can confirm the issue is resolved and has not introduced any new regressions.


This plan outlines the sequence of actions I will take to address the critical bugs and architectural flaws in the ContextMover extension. The priority is to restore core functionality and stabilize the platform integrations.

**Phase 1: Restore Core Backend and Admin Functionality**

The highest priority is to fix the backend services, as many other features depend on them.

1.  **Task: `Fix Admin Panel API Authorization`**
    *   **Action:** I will investigate the backend API codebase, specifically focusing on the authentication and authorization middleware for the `/api/scraper-admin/*` routes. I will search for the code that checks user roles and permissions.
    *   **Hypothesis:** The logic that identifies a user as an administrator is likely flawed or pointing to an incorrect role identifier in the user's session or JWT.
    *   **Goal:** Restore full access to the admin panel by correcting the role-checking mechanism.

2.  **Task: `Fix Attention Engine`**
    *   **Action (Part 1 - `web-tree-sitter`):** I have already identified the fix for this by creating a Vite plugin to copy the necessary WASM files. The next step is to run the build process to apply this change.
    *   **Action (Part 2 - Timeout):** I will investigate the offscreen document (`src/offscreen/offscreen.html` and its associated scripts) where the embedding model runs. I will analyze the code to understand why the process is timing out.
    *   **Hypothesis:** The model may be processing too much data at once, or there may be an inefficient data transfer method between the service worker and the offscreen document.
    *   **Goal:** Implement a more robust and efficient embedding process that does not time out, potentially by batching the data or optimizing the model execution.

**Phase 2: Address Systemic Architectural Flaws**

Once the backend is stable, I will address the core architectural issues in the extension itself.

3.  **Task: `Fix Systemic Capture Trigger`**
    *   **Action:** I will analyze the content script lifecycle and the message passing between the content scripts and the service worker. I will focus on how the extension detects URL changes and triggers the capture process.
    *   **Hypothesis:** The extension is likely relying on a simple URL change listener that doesn't fire correctly for in-page navigations (common in single-page apps) or when a page is loaded from the cache.
    *   **Goal:** Implement a more robust trigger mechanism that reliably initiates a full page scrape whenever the user navigates to a new or existing conversation, regardless of how the page is loaded.

**Phase 3: Repair Platform Scrapers**

With the core architecture stabilized, I will work through the broken scrapers one by one.

4.  **Tasks: `Fix Gemini Scraper`, `Fix ChatGPT Scraper`, `Fix Perplexity Scraper`, `Fix Groq Scraper`, `Fix DeepSeek Scraper`, `Fix Claude Scraper`**
    *   **Action:** For each platform, I will:
        1.  Launch the target website.
        2.  Use the browser's developer tools to inspect the current DOM structure of the chat interface.
        3.  Identify the new, correct CSS selectors for messages, user roles, and content.
        4.  Update the corresponding scraper configuration file in the extension's source code.
    *   **Goal:** Restore reliable, full-conversation capture for all supported platforms.

**Phase 4: Resolve Remaining High-Priority Bugs**

Finally, I will address the remaining high-priority issues.

5.  **Task: `Fix Gemini Injection`**
    *   **Action:** I will debug the Gemini content script to understand why it's failing to interact with the prompt input field.
    *   **Hypothesis:** The CSS selector for the input field has likely changed, or there may be a new event listener on the page interfering with our script's ability to set the input's value.
    *   **Goal:** Restore the ability to inject context into the Gemini prompt.
