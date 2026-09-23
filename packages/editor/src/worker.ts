/**
 * The editor script's entry: every request is an asset. The router reaches it
 * over a service binding. A path with no file is a deep link into the page and
 * gets `index.html`, except under `/assets/`: a chunk that is gone, because a
 * deploy replaced the build while a page was open, is a 404, so the page fails
 * loudly and the router logs it, instead of getting the page as JavaScript.
 */
export default {
  async fetch(request: Request, env: { ASSETS: Fetcher }): Promise<Response> {
    const response = await env.ASSETS.fetch(request);

    if (response.status !== 404 || new URL(request.url).pathname.startsWith("/assets/"))
      return response;

    return env.ASSETS.fetch(new Request(new URL("/", request.url), request));
  },
};
