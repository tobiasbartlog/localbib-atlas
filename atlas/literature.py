"""Literatur-Abgleich of a Publication (#226) — pure.

Manuscript × literature source × library: the union of the cite keys of every
linked manuscript (in order of first appearance) and the publication's
literature source (the Collection, live — or else its ``refs``). Each key
gets

- ``cited`` — it appears in a linked manuscript,
- ``in_source`` — it belongs to the Collection / ``refs``,
- ``in_library`` with the Item's data (``item_id``, title, authors, year,
  DOI, ``has_pdf``) when the library knows the key,
- otherwise title/authors/year/DOI from a ``.bib`` file of the publication's
  document folder, if one names the key (``from_bib``).

``counts`` feed the bar, its legend and the filters. The bar is a partition:
``cited_in_library`` + ``uncited`` + ``cited_missing`` == ``total``. Atlas
never adds anything to the library or a Collection — missing papers are only
listed (P2).

No I/O: the router hands in the keys, a resolver and the parsed ``.bib``.
"""

from __future__ import annotations

from typing import Callable, Iterable, Optional


def literature_rows(
    cited_keys: Iterable[str],
    source_keys: Iterable[str],
    resolve: Callable[[str], Optional[dict]],
    bib_entries: Iterable[dict] = (),
) -> dict:
    cited = list(dict.fromkeys(k for k in cited_keys if k))
    source = list(dict.fromkeys(k for k in source_keys if k))
    cited_set, source_set = set(cited), set(source)
    bib = {}
    for entry in bib_entries:
        bib.setdefault(entry.get("key"), entry)

    rows: list[dict] = []
    for key in list(dict.fromkeys(cited + source)):
        ref = resolve(key)
        row = {
            "key": key,
            "cited": key in cited_set,
            "in_source": key in source_set,
            "in_library": ref is not None,
            "item_id": None,
            "title": None,
            "authors": None,
            "year": None,
            "doi": None,
            "has_pdf": False,
            "from_bib": False,
        }
        if ref is not None:
            row.update(
                item_id=ref.get("id"),
                title=ref.get("title") or None,
                authors=ref.get("authors") or None,
                year=ref.get("year"),
                doi=ref.get("doi") or None,
                has_pdf=bool(ref.get("has_pdf")),
            )
        elif key in bib:
            entry = bib[key]
            row.update(
                title=entry.get("title"),
                authors=entry.get("author"),
                year=entry.get("year"),
                doi=entry.get("doi"),
                from_bib=True,
            )
        rows.append(row)

    in_lib = [r for r in rows if r["in_library"]]
    counts = {
        "total": len(rows),
        "cited": sum(1 for r in rows if r["cited"]),
        "cited_in_library": sum(1 for r in rows if r["cited"] and r["in_library"]),
        "uncited": sum(1 for r in rows if not r["cited"]),
        "cited_missing": sum(1 for r in rows if r["cited"] and not r["in_library"]),
        "missing": sum(1 for r in rows if not r["in_library"]),
        "with_pdf": sum(1 for r in in_lib if r["has_pdf"]),
        "without_pdf": sum(1 for r in in_lib if not r["has_pdf"]),
    }
    return {"rows": rows, "counts": counts}


def citation_check(keys: Iterable[str], resolve: Callable[[str], Optional[dict]],
                   bib_entries: Iterable[dict] = ()) -> dict:
    """"Text einfügen": the keys of a pasted TeX text against the library —
    the same row form as :func:`literature_rows` (every key ``cited``)."""
    result = literature_rows(keys, (), resolve, bib_entries)
    counts = result["counts"]
    return {
        "rows": result["rows"],
        "counts": {
            "total": counts["total"],
            "in_library": counts["cited_in_library"],
            "missing": counts["cited_missing"],
        },
    }
