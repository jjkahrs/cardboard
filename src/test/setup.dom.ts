import '@testing-library/jest-dom/vitest';

/**
 * jsdom 26 ships `Blob`/`File` but not `Blob.prototype.text()`. Every browser this app targets has
 * it, so the gap is patched here rather than branched around in `GameListScreen`'s importer —
 * `FileReader`, which jsdom does implement, is exactly what the method is defined as doing.
 */
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
