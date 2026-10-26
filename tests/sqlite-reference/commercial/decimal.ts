import { CommercialError } from "./validation";

export type Decimal = { coefficient: bigint; scale: number };
const power = (scale: number) => 10n ** BigInt(scale);
export function decimal(value: string): Decimal {
  if (!/^-?(?:0|[1-9][0-9]{0,17})(?:\.[0-9]{1,18})?$/.test(value)) throw new CommercialError(400);
  const negative = value.startsWith("-");
  const [integer = "0", fraction = ""] = (negative ? value.slice(1) : value).split(".");
  return { coefficient: BigInt(integer + fraction) * (negative ? -1n : 1n), scale: fraction.length };
}
export function add(a: Decimal, b: Decimal): Decimal {
  const scale = Math.max(a.scale, b.scale);
  return { coefficient: a.coefficient * power(scale - a.scale) + b.coefficient * power(scale - b.scale), scale };
}
export function negate(value: Decimal): Decimal { return { ...value, coefficient: -value.coefficient }; }
export function subtract(a: Decimal, b: Decimal): Decimal { return add(a, negate(b)); }
export function multiply(a: Decimal, b: Decimal): Decimal {
  return { coefficient: a.coefficient * b.coefficient, scale: a.scale + b.scale };
}
export function percent(value: Decimal, rate: Decimal): Decimal {
  const product = multiply(value, rate);
  return { ...product, scale: product.scale + 2 };
}
export function compare(a: Decimal, b: Decimal): number {
  const difference = subtract(a, b).coefficient;
  return difference === 0n ? 0 : difference < 0n ? -1 : 1;
}
export function exact(value: Decimal): string {
  const negative = value.coefficient < 0n;
  const digits = (negative ? -value.coefficient : value.coefficient).toString().padStart(value.scale + 1, "0");
  const fraction = value.scale ? digits.slice(-value.scale).replace(/0+$/, "") : "";
  const integer = value.scale ? digits.slice(0, -value.scale) : digits;
  return `${negative ? "-" : ""}${integer}${fraction ? `.${fraction}` : ""}`;
}
// PHP round(..., 2) defaults to half away from zero. Round only displayed/final
// totals; the source adds unrounded lines before rounding the subtotal.
export function money(value: Decimal): string {
  const negative = value.coefficient < 0n;
  let magnitude = negative ? -value.coefficient : value.coefficient;
  if (value.scale > 2) {
    const divisor = power(value.scale - 2);
    magnitude = (magnitude + divisor / 2n) / divisor;
  } else magnitude *= power(2 - value.scale);
  const digits = magnitude.toString().padStart(3, "0");
  return `${negative && magnitude ? "-" : ""}${digits.slice(0, -2)}.${digits.slice(-2)}`;
}
