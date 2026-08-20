import { handToBrowser, type Destination } from '../export/destination.ts';
import { writeDocument, type RotylDocument } from './document-file.ts';

/**
 * Put a document where the destination says, which is the export path's
 * question asked about a much smaller thing.
 *
 * ONE DESTINATION PATH AND NOT TWO. A clip asks where it goes before it
 * encodes anything, because the answer might be "nowhere" and by then the file
 * would be in memory. A document has neither of those problems: it is ten
 * milliseconds of work and 65 MB at the very worst, so the ordering argument
 * that made the picker come first for a clip does not apply here. What does
 * apply is that a product with two ways of asking would ask them differently,
 * so it goes through `chooseFile` like everything else and this is one branch
 * either side of the same `Destination`.
 *
 * WRITTEN AS CHUNKS INTO THE STREAM rather than assembled first. The masks in
 * the chunk list are the log's own arrays, so a save touches every byte exactly
 * once and holds nothing beyond the header. The same reason the clip sink
 * writes each packet as its chunk closes, arriving at a smaller scale.
 *
 * A WRITE THAT FAILS PART WAY LEAVES A FILE THAT IS REFUSED RATHER THAN
 * BELIEVED. A page can neither delete a file it was handed nor stop a writable
 * stream committing when it closes, which is why a stopped clip export finishes
 * the file instead of abandoning it. A truncated document needs no such care:
 * the header states its own length and the payload offsets are absolute, so a
 * short file fails `readDocument` as damaged rather than replaying the part
 * that arrived.
 */
export async function saveDocument(
  document: RotylDocument,
  destination: Destination,
  suggestedName: string,
): Promise<string> {
  const chunks = writeDocument(document);

  if (destination.kind === 'download') {
    await handToBrowser(new Blob([...chunks]), suggestedName);
    return suggestedName;
  }

  const writer = (await destination.handle.createWritable()).getWriter();
  try {
    for (const chunk of chunks) await writer.write(chunk);
    await writer.close();
  } catch (cause) {
    // Released so the stream does not stay locked, and swallowed so the write's
    // own failure is the one that reaches the caller.
    writer.releaseLock();
    throw cause;
  }
  return destination.name;
}
