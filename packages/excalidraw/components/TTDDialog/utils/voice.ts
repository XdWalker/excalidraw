/**
 * Appends what was said to what's already typed (fork ia-local, fase 4):
 * a space in between, and a capital letter when it starts the request.
 */
export const appendSpokenText = (current: string, spoken: string) => {
  const text = spoken.trim();
  if (!text) {
    return current;
  }
  const before = current.replace(/\s+$/, "");
  if (!before) {
    return text.charAt(0).toUpperCase() + text.slice(1);
  }
  return `${before} ${text}`;
};
