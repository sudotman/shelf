// End-to-end tests for the admin console against an in-memory GitHub.
import { expect, test } from "@playwright/test";
import { parse } from "yaml";
import { fakeGitHub, gitSha, read, waldenEpub } from "./helpers/fake-github.js";

async function connect(page) {
  await page.goto("/admin/");
  await expect(page.getByRole("heading", { name: "Look after the shelf from any browser." })).toBeVisible();
  await page.getByLabel("GitHub token").fill("test-token");
  await page.getByRole("button", { name: "Connect" }).click();
  await expect(page.locator("#book-list")).toContainText("Meditations");
}

async function backToList(page) {
  const back = page.locator(".pane .back-button");
  if (await back.isVisible()) await back.click();
}

async function openBook(page, title) {
  await backToList(page);
  await page.locator("#book-list .list-item", { hasText: title }).click();
  await expect(page.locator(".editor h2")).toHaveText(title);
}

test.beforeEach(async ({ page }) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (process.env.SHOW_CONSOLE) console.log("[page]", message.type(), message.text());
    if (message.type() === "error") errors.push(message.text());
  });
  test.info().annotations.push({ type: "errors", description: "" });
  page.errors = errors;
});

test.afterEach(async ({ page }) => {
  expect(page.errors).toEqual([]);
});

test("adds, edits, and removes books in one published commit", async ({ page }) => {
  const github = await fakeGitHub(page);
  await connect(page);
  await expect(page.locator("#book-list .list-item")).toHaveCount(3);

  // The exact file already on the shelf is caught before it is uploaded.
  await page.locator("#file-input").setInputFiles({ name: "Meditations (copy).epub", mimeType: "application/epub+zip", buffer: read("books/philosophy/meditations.epub") });
  await expect(page.locator(".notices")).toContainText("already on the shelf as books/philosophy/meditations.epub");
  await expect(page.locator("#changes-summary")).toContainText("1 to fix first");
  await page.locator("#publish-button").click();
  await expect(page.locator("#publish-dialog")).not.toBeVisible();
  await expect(page.locator("#toast")).toContainText("already on the shelf");
  await page.getByRole("button", { name: "Leave it out" }).first().click();

  // A new book is read in the browser and filed.
  await page.locator("#file-input").setInputFiles({ name: "walden.epub", mimeType: "application/epub+zip", buffer: waldenEpub() });
  await expect(page.locator(".editor h2")).toHaveText("Walden");
  await expect(page.locator(".editor .byline")).toHaveText("Henry David Thoreau");
  await page.getByLabel(/^Shelf/).fill("Essays");
  await page.getByLabel(/^Tags/).fill("nature, essays");
  await page.getByRole("button", { name: "Reading", exact: true }).click();
  await page.getByRole("button", { name: "4 stars" }).click();
  await expect(page.locator(".editor .facts")).toContainText("books/essays/walden.epub");

  // Unpublished work survives a reload, file included.
  await page.reload();
  await expect(page.locator("#toast")).toContainText("Picked up where you left off");
  await expect(page.locator("#book-list .list-item", { hasText: "Walden" })).toContainText("New");

  await openBook(page, "Meditations");
  await page.getByRole("button", { name: "Read", exact: true }).click();
  await expect(page.locator(".field.is-changed")).toHaveCount(1);

  await openBook(page, "Self-Reliance");
  await page.getByRole("button", { name: "Remove from the shelf" }).click();
  await expect(page.locator(".notices")).toContainText("taken off the shelf");

  await expect(page.locator("#changes-summary")).toContainText("3 unpublished changes");
  await page.locator("#publish-button").click();
  await expect(page.locator("#publish-lines li")).toHaveText(["Update Meditations", "Remove Self-Reliance", "Add Walden"]);
  await page.locator("#publish-confirm").click();
  await expect(page.locator("#publish-title")).toHaveText("Published", { timeout: 30_000 });
  await expect(page.locator("#publish-steps .step[data-state=done]")).toHaveCount(4);

  expect(github.log.uploads).toEqual([waldenEpub().length]);
  expect(github.log.commits).toHaveLength(1);
  expect(github.log.commits[0].message).toMatch(/^Shelf: add 1 book, update 1, remove 1\n\n- Update Meditations\n- Remove Self-Reliance\n- Add Walden$/);
  const files = github.files();
  expect(files.has("books/essays/walden.epub")).toBe(true);
  expect(files.get("books/essays/walden.epub").sha).toBe(gitSha(waldenEpub()));
  expect(files.has("books/essays/self-reliance.pdf")).toBe(false);
  expect(files.has("books/philosophy/meditations.epub")).toBe(true);
  const config = parse(github.text(files.get("shelf.yml").sha));
  expect(config.books.walden).toEqual({ tags: ["nature", "essays"], status: "reading", rating: 4 });
  expect(config.books.meditations).toEqual({ tags: ["stoicism"], status: "read" });
  expect(config.books["self-reliance"]).toBeUndefined();
  expect(github.text(files.get("shelf.yml").sha)).toContain("# Per-book overrides");

  await page.locator("#publish-cancel").click();
  await expect(page.locator("#changes-bar")).toBeHidden();
});

test("reads a new PDF in the browser: title, pages, and a rendered cover", async ({ page }) => {
  await fakeGitHub(page);
  await connect(page);
  // A changed byte at the end keeps it a valid PDF but makes it a new file.
  const pdf = Buffer.concat([read("books/essays/self-reliance.pdf"), Buffer.from("\n% second printing\n")]);
  await page.locator("#file-input").setInputFiles({ name: "self-reliance-2.pdf", mimeType: "application/pdf", buffer: pdf });
  await expect(page.locator(".editor h2")).toHaveText("Self-Reliance", { timeout: 20_000 });
  await expect(page.locator(".editor .facts")).toContainText("PDF");
  await expect(page.locator(".editor .facts")).toContainText("36 pages");
  await expect(page.locator(".editor .notices")).toContainText("no author");
  await expect(page.locator(".cover-frame img")).toBeVisible();
  expect(await page.locator(".cover-frame img").evaluate((image) => image.naturalWidth)).toBeGreaterThan(100);
  // Same title as a book on the shelf, so it gets a distinct name.
  await page.locator(".more summary").click();
  await expect(page.locator("input[name=id]")).not.toHaveValue("self-reliance");
});

test("explains a token that cannot write", async ({ page }) => {
  await fakeGitHub(page, { canWrite: false });
  await page.goto("/admin/");
  await page.getByLabel("GitHub token").fill("read-only-token");
  await page.getByRole("button", { name: "Connect" }).click();
  await expect(page.locator("#connect-error")).toContainText("can read sudotman/shelf but not change it");
});

test("explains a rejected token", async ({ page }) => {
  await fakeGitHub(page, { status: 401 });
  await page.goto("/admin/");
  await page.getByLabel("GitHub token").fill("expired-token");
  await page.getByRole("button", { name: "Connect" }).click();
  await expect(page.locator("#connect-error")).toContainText("did not accept the token");
  // Failed API calls are expected here; they are not page errors.
  page.errors.length = 0;
});
