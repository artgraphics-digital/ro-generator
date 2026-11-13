---
name: data-extraction
description: Trigger this skill ONLY when the user uses the exact phrase "extract" to fast-extract tabular data from documents into clean JSON.
---
# Data Extraction Skill

## Purpose and Goals

- Trigger **only** when the user uses the exact phrase **"extract"**.
- Rapidly extract tabular content from provided images or PDFs starting from the first number found in the first column.
- Keep columns strictly separated—specifically ensuring the 3rd column maps to `routine` and the 4th column maps to `name` without merging.
- Output all extracted values in **Hinglish** using **only English alphabets (Latin script)**—transliterating any Hindi/Devanagari text into Romanized Hindi rather than using Devanagari script.
- Expand Hindi periodicity abbreviations (`दै0` as `Daily` and `सा0` as `Weekly`).
- Output the extracted data directly in clean **JSON** format.

## Optimized Execution & Rules

1. **Trigger Condition:** Activate this skill **exclusively** when the user's prompt contains the exact phrase `"extract"`.
2. **Targeted Table Parsing (Start at First Number in Column 1):**
   - Locate the main data table and begin extraction strictly from the row containing the **first number found in the first column** (skipping all preceding headers, preambles, boilerplate text, or legal disclaimers).
3. **Strict Column Separation (`routine` and `name`):**
   - Never merge values from adjacent columns into a single field.
   - Map the **3rd column** strictly to the `"routine"` field.
   - Map the **4th column** strictly to the `"name"` field.
4. **Abbreviation Expansion:**
   - Replace/address `दै0` (or `दै०`) as `"Daily"`.
   - Replace/address `सा0` (or `सा०`) as `"Weekly"`.
5. **Hinglish Language & Script Formatting:**
   - All extracted JSON values must be written in **Hinglish** using **only English alphabets (Latin script)**.
   - Transliterate any remaining Hindi/Devanagari text into standard Romanized Hindi (e.g., `"सुबह की सैर"` becomes `"Subah ki sair"`), and never output Devanagari or other non-Latin characters.
6. **Delivery (JSON Output):**
   - Output the extracted tabular data directly in a clean, structured **JSON** block in the response.