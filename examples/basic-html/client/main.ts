/** The page's script, bundled from TypeScript and served at /main.js. */
const clock = document.getElementById("clock")!;

const tick = () => {
  clock.textContent = new Date().toLocaleTimeString();
};

tick();
setInterval(tick, 1000);
