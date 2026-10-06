// Stands in for @xmldom/xmldom in the browser (see the import map in
// index.html) so ../lib/epub.js reads EPUBs with the native parser and still
// learns about fatal errors through its onError callback.
export class DOMParser {
  constructor({ onError } = {}) {
    this.onError = onError;
  }

  parseFromString(source, type) {
    const document = new globalThis.DOMParser().parseFromString(source, type);
    const error = document.getElementsByTagName("parsererror")[0];
    if (error) this.onError?.("fatalError", error.textContent);
    return document;
  }
}
