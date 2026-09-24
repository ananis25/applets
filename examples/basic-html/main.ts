/** A static web page: HTML and CSS files imported as text and served by path, styled with Pico. */
import page from "./index.html";
import styles from "./style.css";

export function fetch(request: Request): Response {
  const { pathname } = new URL(request.url);

  if (pathname === "/style.css")
    return new Response(styles, { headers: { "content-type": "text/css; charset=utf-8" } });

  return new Response(page, { headers: { "content-type": "text/html; charset=utf-8" } });
}
