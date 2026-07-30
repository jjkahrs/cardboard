import '@testing-library/jest-dom/vitest';

/**
 * jsdom 26 ships `Blob`/`File` but not `Blob.prototype.text()`. Every browser this app targets has
 * it, so the gap is patched here rather than branched around in `GameListScreen`'s importer —
 * `FileReader`, which jsdom does implement, is exactly what the method is defined as doing.
 */
/**
 * The same gap, one element along: jsdom 26 has `HTMLDialogElement` and its `open` property but
 * neither `showModal()` nor `close()`. `NewGameDialog` uses a real `<dialog>` precisely so the focus
 * trap and Esc-to-close are the platform's problem, and branching around jsdom in the component
 * would defeat that — so the two methods are defined here as the spec defines them, minus the top
 * layer and the focus trap, which are not observable in jsdom anyway.
 *
 * Esc is listened for on the document, not the dialog: a browser closes the topmost modal dialog on
 * Esc wherever focus is, and jsdom does not move focus into the dialog for us.
 */
if (typeof HTMLDialogElement.prototype.showModal !== 'function') {
  const onEscape = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      for (const dialog of document.querySelectorAll('dialog[open]')) {
        (dialog as HTMLDialogElement).close();
      }
    }
  };
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.open = true;
    document.addEventListener('keydown', onEscape);
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    if (!this.open) return;
    this.open = false;
    document.removeEventListener('keydown', onEscape);
    this.dispatchEvent(new Event('close'));
  };
}

if (typeof Blob.prototype.text !== 'function') {
  Blob.prototype.text = function (this: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsText(this);
    });
  };
}
