"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import type { QuotationInput } from "@/server/commercial/quotations";
import type { CommercialPage, ProductRecord } from "@/server/commercial/persistence-contracts";
import { useRead } from "./read-client";

type Item = QuotationInput["items"][number];
type Product = ProductRecord & { id: string };

// The PHP Select2 workflow keeps the selected line until a result is selected
// or explicitly cleared. Search text is a separate, unsaved selection draft.
export function ProductSearch({ index, selectedProductId, initialProductName = "", disabled = false, onChange }: {
  index: number; selectedProductId: string; initialProductName?: string; disabled?: boolean;
  onChange: (patch: Partial<Item>) => void;
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null), popup = useRef<HTMLDivElement>(null), searchInput = useRef<HTMLInputElement>(null);
  const results = useRef<HTMLUListElement>(null);
  const [open, setOpen] = useState(false), [search, setSearch] = useState(""), [debounced, setDebounced] = useState("");
  const [page, setPage] = useState(1), [active, setActive] = useState(0);
  const [chosen, setChosen] = useState<{ id: string; name: string }>();
  const [position, setPosition] = useState<CSSProperties>({ position: "fixed", visibility: "hidden" });
  const query = search.trim();
  const visible = open && !disabled;
  const url = visible && query.length >= 2 && query === debounced
    ? "/api/items?" + new URLSearchParams({ query, page: String(page), pageSize: "25" }) : null;
  const products = useRead<CommercialPage<Product>>(url);
  const counts = new Map<string, number>();
  for (const product of products.data?.items ?? []) counts.set(product.externalId, (counts.get(product.externalId) ?? 0) + 1);
  const choices = (products.data?.items ?? []).filter(product => !!product.externalId && counts.get(product.externalId) === 1);
  const ambiguous = choices.length !== (products.data?.items.length ?? 0);
  const selectedName = chosen?.id === selectedProductId ? chosen.name : initialProductName;
  const activeChoice = choices[active];

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query), 200);
    return () => clearTimeout(timer);
  }, [query]);
  useLayoutEffect(() => {
    if (!visible) return;
    function place() {
      const rect = trigger.current?.getBoundingClientRect();
      if (!rect) return;
      const viewport = window.visualViewport;
      const left = (viewport?.offsetLeft ?? 0) + 12, top = (viewport?.offsetTop ?? 0) + 12;
      const right = left + (viewport?.width ?? document.documentElement.clientWidth) - 24;
      const bottom = top + (viewport?.height ?? window.innerHeight) - 24;
      // A detached picker must not linger after its control leaves the viewport.
      if (rect.bottom <= top || rect.top >= bottom || rect.right <= left || rect.left >= right) {
        setOpen(false); return;
      }
      const width = Math.max(0, Math.min(rect.width, right - left));
      const below = Math.max(0, bottom - rect.bottom), above = Math.max(0, rect.top - top);
      const upwards = below < 320 && above > below;
      setPosition({ position: "fixed", visibility: "visible", width,
        left: Math.max(left, Math.min(rect.left, right - width)),
        top: upwards ? Math.min(rect.top, bottom) : Math.max(rect.bottom, top),
        transform: upwards ? "translateY(-100%)" : undefined,
        maxHeight: Math.min(320, upwards ? above : below) });
    }
    function outside(event: PointerEvent) {
      if (event.target instanceof Node && !popup.current?.contains(event.target) && !trigger.current?.parentElement?.contains(event.target)) setOpen(false);
    }
    function reposition(event: Event) {
      // Scrolling results does not move the anchor. Do not feed it back into placement.
      if (event.target instanceof Node && popup.current?.contains(event.target)) return;
      place();
    }
    // Measure before paint; the portal never participates in body-tail layout.
    place();
    const resize = new ResizeObserver(place);
    if (trigger.current) resize.observe(trigger.current);
    const viewport = window.visualViewport;
    document.addEventListener("pointerdown", outside);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", reposition, true);
    viewport?.addEventListener("resize", place);
    viewport?.addEventListener("scroll", place);
    return () => {
      resize.disconnect();
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", reposition, true);
      viewport?.removeEventListener("resize", place);
      viewport?.removeEventListener("scroll", place);
    };
  }, [visible]);
  useLayoutEffect(() => {
    // The first measurement makes the initially hidden portal focusable.
    if (visible && position.visibility === "visible") searchInput.current?.focus({ preventScroll: true });
  }, [visible, position.visibility]);

  function revealOption(index: number) {
    const list = results.current, option = list?.children[index];
    if (!list || !option) return;
    const listRect = list.getBoundingClientRect(), optionRect = option.getBoundingClientRect();
    // scrollIntoView also scrolls the long quotation page (smoothly in the source
    // theme), moving the anchor out from under the popup. Scroll only this list.
    if (optionRect.top < listRect.top) list.scrollTop -= listRect.top - optionRect.top;
    else if (optionRect.bottom > listRect.bottom) list.scrollTop += optionRect.bottom - listRect.bottom;
  }

  function close(restoreFocus = true) {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus({ preventScroll: true });
  }
  function show() {
    if (disabled || trigger.current?.matches(":disabled")) return;
    setSearch(""); setPage(1); setActive(0); setOpen(true);
  }
  function select(product: Product) {
    if (disabled || trigger.current?.matches(":disabled")) return;
    setChosen({ id: product.externalId, name: product.name });
    onChange({ productId: product.externalId, productName: product.name,
      description: product.description ?? "", unitPrice: product.unitPrice ?? "0" });
    close();
  }
  function keys(event: KeyboardEvent) {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
    else if (event.target === searchInput.current && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      const next = Math.max(0, Math.min(choices.length - 1, active + (event.key === "ArrowDown" ? 1 : -1)));
      setActive(next);
      // Also reveal a boundary option when the list was independently wheeled away.
      revealOption(next);
    } else if (event.target === searchInput.current && event.key === "Enter") {
      event.preventDefault();
      if (activeChoice) select(activeChoice);
    } else if (event.key === "Tab") {
      // The popup is in the top layer of the page, outside the scrolling table.
      // Continue tab order from the original control rather than the body tail.
      const controls = Array.from(trigger.current?.form?.querySelectorAll<HTMLElement>("button,input,select,textarea,a[href]") ?? [])
        .filter(element => !element.matches(":disabled") && element.tabIndex >= 0 && element.getClientRects().length > 0);
      const next = controls[controls.indexOf(trigger.current!) + (event.shiftKey ? -1 : 1)];
      event.preventDefault(); close(false); (next ?? trigger.current)?.focus();
    }
  }
  return <div className="crm-product-picker mb-1">
    <button ref={trigger} type="button" className="form-control form-control-sm crm-product-selection" disabled={disabled}
      aria-label={`Item ${index + 1} product`} aria-haspopup="listbox" aria-expanded={visible} aria-controls={visible ? `${id}-results` : undefined}
      aria-describedby={`${id}-selected`} title={selectedProductId ? selectedName || "Current product" : undefined}
      onClick={() => visible ? close() : show()} onKeyDown={event => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); show(); }
      }}><span id={`${id}-selected`} className={selectedProductId ? "" : "text-muted"}>{selectedProductId ? selectedName || "Current product" : "Search item..."}</span><span className="crm-product-caret" aria-hidden="true" /></button>
    {selectedProductId && <button type="button" className="crm-product-clear" aria-label={`Clear item ${index + 1} product`} disabled={disabled}
      onClick={() => { onChange({ productId: "", productName: "", description: "", unitPrice: "0" }); setChosen(undefined); close(false); trigger.current?.focus({ preventScroll: true }); }}>×</button>}
    {visible && createPortal(<div ref={popup} className="crm-product-dropdown" style={position} onKeyDown={keys}>
      <div className="crm-product-search"><input ref={searchInput} type="search" className="form-control form-control-sm" role="combobox"
        aria-label={`Item ${index + 1} product search`} aria-autocomplete="list" aria-expanded="true" aria-controls={`${id}-results`}
        aria-activedescendant={activeChoice ? `${id}-option-${active}` : undefined} autoComplete="off" maxLength={120}
        value={search} onChange={event => { setSearch(event.target.value); setPage(1); setActive(0); }} /></div>
      {query.length < 2 && <p role="status">Please enter 2 or more characters.</p>}
      {query.length >= 2 && (query !== debounced || products.loading) && <p role="status">Searching...</p>}
      {products.error && <p role="alert">{products.error}</p>}
      {ambiguous && <p role="alert">Some product results could not be identified. Refine your search.</p>}
      <ul ref={results} id={`${id}-results`} role="listbox" aria-label={`Item ${index + 1} product results`}>
        {choices.map((product, optionIndex) => <li id={`${id}-option-${optionIndex}`} key={product.externalId} role="option"
          aria-selected={optionIndex === active} aria-label={`${product.name} (${product.externalId})`}
          onPointerMove={() => setActive(optionIndex)} onMouseDown={event => event.preventDefault()} onClick={() => select(product)}>
          {product.name}<small>{product.externalId}</small>
        </li>)}
      </ul>
      {products.data?.total === 0 && <p role="status">No results found.</p>}
      {products.data && products.data.total > products.data.pageSize && <div className="crm-product-pages">
        <button type="button" disabled={page <= 1} aria-label={`Previous item ${index + 1} product results`} onClick={() => { setPage(value => value - 1); setActive(0); searchInput.current?.focus({ preventScroll: true }); }}>Previous</button>
        <span>Page {page} of {Math.ceil(products.data.total / products.data.pageSize)}</span>
        <button type="button" disabled={page * products.data.pageSize >= products.data.total} aria-label={`Next item ${index + 1} product results`} onClick={() => { setPage(value => value + 1); setActive(0); searchInput.current?.focus({ preventScroll: true }); }}>Next</button>
      </div>}
    </div>, document.body)}
  </div>;
}
