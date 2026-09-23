/** A `.md` import is the file's text, see `docs.ts`. */
declare module "*.md" {
  const text: string;
  export default text;
}
