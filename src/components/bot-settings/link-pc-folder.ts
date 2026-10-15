/** Choose on this PC: main shows the picker and links the folder; the bot then works in its Cloud copy. */
export async function linkPcFolder(bridge: { linkFolder(): Promise<{ cloudPath: string } | null> }, save: (cwd: string) => Promise<void>): Promise<string | null> {
  try {
    const linked = await bridge.linkFolder();
    if (linked) await save(linked.cloudPath);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
