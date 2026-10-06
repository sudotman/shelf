// A small GitHub REST client for the admin console. Everything goes to
// api.github.com with the owner's token; nothing else sees it.
const API = "https://api.github.com";

export class GitHubError extends Error {
  constructor(message, status, details = null) {
    super(message);
    this.name = "GitHubError";
    this.status = status;
    this.details = details;
  }
}

function explain(status, payload) {
  const message = payload?.message || "";
  if (status === 401) return "GitHub did not accept the token. It may have expired or been revoked.";
  if (status === 403 && /rate limit/i.test(message)) return "GitHub’s rate limit was reached. Try again in a few minutes.";
  if (status === 403) return "The token is not allowed to do that. It needs Contents: Read and write on this repository.";
  if (status === 404) return "GitHub could not find that repository or file with this token.";
  if (status === 409 || status === 422) return message || "GitHub rejected the change.";
  return message || `GitHub answered ${status}.`;
}

function decodeBase64Text(content) {
  const binary = atob(content.replace(/\s/g, ""));
  return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
}

function fileAsBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).slice(String(reader.result).indexOf(",") + 1));
    reader.onerror = () => reject(reader.error || new Error("The file could not be read."));
    reader.readAsDataURL(blob);
  });
}

export class GitHub {
  constructor({ token, repository, fetchImpl = globalThis.fetch.bind(globalThis) }) {
    this.token = token;
    this.repository = repository;
    this.fetch = fetchImpl;
  }

  headers(extra = {}) {
    return {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${this.token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...extra,
    };
  }

  async request(path, { method = "GET", body } = {}) {
    let response;
    try {
      response = await this.fetch(`${API}${path}`, {
        method,
        headers: this.headers(body ? { "Content-Type": "application/json" } : {}),
        body: body ? JSON.stringify(body) : undefined,
        cache: "no-store",
      });
    } catch {
      throw new GitHubError("GitHub could not be reached. Check the connection and try again.", 0);
    }
    const payload = response.status === 204 ? null : await response.json().catch(() => null);
    if (!response.ok) throw new GitHubError(explain(response.status, payload), response.status, payload);
    return payload;
  }

  repo(path = "") {
    return `/repos/${this.repository}${path}`;
  }

  // Who is signed in, and whether they can write to the shelf.
  async verify() {
    const [user, repository] = await Promise.all([this.request("/user"), this.request(this.repo())]);
    return {
      login: user.login,
      avatar: user.avatar_url,
      canWrite: Boolean(repository.permissions?.push),
      branch: repository.default_branch || "main",
      private: repository.private,
    };
  }

  // The current state of the branch: every file path with its blob sha, and
  // the text of shelf.yml.
  async snapshot(branch) {
    const ref = await this.request(this.repo(`/git/ref/heads/${encodeURIComponent(branch)}`));
    const commit = await this.request(this.repo(`/git/commits/${ref.object.sha}`));
    const tree = await this.request(this.repo(`/git/trees/${commit.tree.sha}?recursive=1`));
    if (tree.truncated) throw new GitHubError("The repository is too large to list in one go.", 0);
    const files = new Map(tree.tree.filter((item) => item.type === "blob").map((item) => [item.path, { sha: item.sha, size: item.size }]));
    const config = files.get("shelf.yml");
    const shelfYaml = config ? decodeBase64Text((await this.request(this.repo(`/git/blobs/${config.sha}`))).content) : "";
    return { headSha: ref.object.sha, treeSha: commit.tree.sha, committedAt: commit.committer?.date || "", files, shelfYaml };
  }

  // Uploads a file as a git blob, reporting progress from 0 to 1. Uses XHR
  // because fetch cannot report upload progress.
  async uploadBlob(blob, onProgress = () => {}) {
    const content = await fileAsBase64(blob);
    return new Promise((resolve, reject) => {
      const request = new XMLHttpRequest();
      request.open("POST", `${API}${this.repo("/git/blobs")}`);
      for (const [name, value] of Object.entries(this.headers({ "Content-Type": "application/json" }))) {
        request.setRequestHeader(name, value);
      }
      request.upload.onprogress = (event) => {
        if (event.lengthComputable) onProgress(event.loaded / event.total);
      };
      request.onload = () => {
        let payload = null;
        try {
          payload = JSON.parse(request.responseText);
        } catch {
          // Leave payload empty; the status explains the failure.
        }
        if (request.status >= 200 && request.status < 300 && payload?.sha) {
          onProgress(1);
          resolve(payload.sha);
        } else {
          reject(new GitHubError(explain(request.status, payload), request.status, payload));
        }
      };
      request.onerror = () => reject(new GitHubError("The upload was interrupted. Check the connection and try again.", 0));
      request.send(JSON.stringify({ content, encoding: "base64" }));
    });
  }

  async commit({ branch, parentSha, baseTreeSha, entries, message }) {
    const tree = await this.request(this.repo("/git/trees"), { method: "POST", body: { base_tree: baseTreeSha, tree: entries } });
    const commit = await this.request(this.repo("/git/commits"), {
      method: "POST",
      body: { message, tree: tree.sha, parents: [parentSha] },
    });
    // Not forced: if the branch moved meanwhile, GitHub refuses and the caller
    // replays the change on top of the new state.
    await this.request(this.repo(`/git/refs/heads/${encodeURIComponent(branch)}`), {
      method: "PATCH",
      body: { sha: commit.sha, force: false },
    });
    return commit.sha;
  }

  async workflowRun(headSha) {
    const runs = await this.request(this.repo(`/actions/runs?head_sha=${headSha}&per_page=5`));
    return runs.workflow_runs?.[0] || null;
  }

  async runJobs(runId) {
    const jobs = await this.request(this.repo(`/actions/runs/${runId}/jobs`));
    return jobs.jobs || [];
  }
}
