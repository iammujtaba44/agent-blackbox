import kleur from "kleur";

const tag = kleur.bold().bgBlack().white(" blackbox ");

export const log = {
  info(msg: string) {
    console.log(`${tag} ${msg}`);
  },
  ok(msg: string) {
    console.log(`${tag} ${kleur.green("✔")} ${msg}`);
  },
  warn(msg: string) {
    console.log(`${tag} ${kleur.yellow("⚠")}  ${msg}`);
  },
  block(msg: string) {
    console.log(`${tag} ${kleur.red().bold("⛔ BLOCKED")} ${msg}`);
  },
  cost(msg: string) {
    console.log(`${tag} ${kleur.cyan("$")} ${msg}`);
  },
  dim(msg: string) {
    console.log(kleur.dim(`${tag} ${msg}`));
  },
};

export function usd(n: number): string {
  return `$${n.toFixed(n < 0.01 ? 4 : 2)}`;
}
