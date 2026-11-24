#!/bin/sh
# Regenerates icu4x_data, the ICU4X data that tuig-ui-model's collator uses. .cargo/config.toml points
# ICU4X_DATA_DIR at it, so the icu_*_data crates use it in place of their bundled data for all locales.
# Needs network access (it downloads CLDR and ICU exports) and `cargo install icu4x-datagen --version <icu version>`.
#
# icu4x-datagen has no root-only locale family: `--locales und` selects every locale, and `en` is the smallest set
# that still exports the root data. English has no collation tailoring. The attribute filter drops the
# alternative orders (stroke, pinyin and so on) that a name sort never asks for.
#
# Run it again after you change the icu_collator version in Cargo.lock. Use the same icu4x-datagen version.
set -eu
cd "$(dirname "$0")/.."
rm -rf icu4x_data
icu4x-datagen \
  --markers \
  CollationDiacriticsV1 CollationJamoV1 CollationMetadataV1 CollationReorderingV1 CollationRootV1 \
  CollationSpecialPrimariesV1 CollationTailoringV1 LocaleLikelySubtagsLanguageV1 LocaleParentsV1 \
  NormalizerNfcV1 NormalizerNfdDataV1 NormalizerNfdSupplementV1 NormalizerNfdTablesV1 NormalizerNfkdDataV1 \
  NormalizerNfkdTablesV1 NormalizerUts46DataV1 \
  --locales en --attribute-filter 'collator=/^$/' --format baked --out icu4x_data
