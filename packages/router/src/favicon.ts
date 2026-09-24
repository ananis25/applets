/**
 * Every applet's `/favicon.ico`: a Lucide icon picked by a hash of its name, so
 * an applet keeps its icon across deploys with nothing stored. Dark strokes,
 * light under a dark browser theme. An applet that wants its own icon links
 * one at another path.
 */
import {
  Anchor,
  Apple,
  Atom,
  Bird,
  Bike,
  Bolt,
  Bone,
  Book,
  Bot,
  Box,
  Brain,
  Bug,
  Cake,
  Camera,
  Cat,
  Cloud,
  Coffee,
  Compass,
  Cpu,
  Crown,
  Diamond,
  Dog,
  Feather,
  Fish,
  Flame,
  Flower,
  Gem,
  Ghost,
  Gift,
  Globe,
  Heart,
  Key,
  Leaf,
  Lightbulb,
  Moon,
  Mountain,
  Music,
  Palette,
  Plane,
  Puzzle,
  Rabbit,
  Rocket,
  Shell,
  Snowflake,
  Sprout,
  Star,
  Sun,
  Trees,
  Umbrella,
  Zap,
  type IconNode,
} from "lucide";

const icons: readonly IconNode[] = [
  Anchor,
  Apple,
  Atom,
  Bird,
  Bike,
  Bolt,
  Bone,
  Book,
  Bot,
  Box,
  Brain,
  Bug,
  Cake,
  Camera,
  Cat,
  Cloud,
  Coffee,
  Compass,
  Cpu,
  Crown,
  Diamond,
  Dog,
  Feather,
  Fish,
  Flame,
  Flower,
  Gem,
  Ghost,
  Gift,
  Globe,
  Heart,
  Key,
  Leaf,
  Lightbulb,
  Moon,
  Mountain,
  Music,
  Palette,
  Plane,
  Puzzle,
  Rabbit,
  Rocket,
  Shell,
  Snowflake,
  Sprout,
  Star,
  Sun,
  Trees,
  Umbrella,
  Zap,
];

/** FNV-1a, enough to spread names over the icons. */
function hash(text: string): number {
  let h = 0x811c9dc5;

  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);

  return h >>> 0;
}

const element = ([tag, attrs]: IconNode[number]) =>
  `<${tag} ${Object.entries(attrs)
    .map(([key, value]) => `${key}="${value}"`)
    .join(" ")}/>`;

/** The SVG for applet `name`. */
export function faviconOf(name: string): string {
  const icon = icons[hash(name) % icons.length]!;

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">`,
    `<style>svg{color:#111}@media (prefers-color-scheme:dark){svg{color:#eee}}</style>`,
    ...icon.map(element),
    `</svg>`,
  ].join("");
}
