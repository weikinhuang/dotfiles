import { StringEnum as PiStringEnum } from '@earendil-works/pi-ai';
import { Type, type TUnsafe } from 'typebox';

/** Preserve TypeBox inference when composing pi-ai's native string-enum schema. */
export function StringEnum<Values extends readonly string[]>(
  values: Values,
  options?: { description?: string; default?: Values[number] },
): TUnsafe<Values[number]> {
  // Since pi-ai 1.5, its Schema<T> brand is not understood by TypeBox Static.
  // TUnsafe supplies TypeBox's type metadata without changing the JSON schema.
  return Type.Unsafe<Values[number]>(PiStringEnum(values, options));
}
