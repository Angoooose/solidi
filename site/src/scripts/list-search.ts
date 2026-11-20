/*
 * Search-as-you-type for a list page's filter box (<form data-list-search>, as on /mints and
 * /denominations): after a pause, load the filtered list in place, keeping the scroll position.
 * Typing drops the paging and any one-group view (?limit, and the form's data-list-search value,
 * e.g. "region").
 */
function setup() {
  const form = document.querySelector<HTMLFormElement>("[data-list-search]")
  const input = form?.querySelector<HTMLInputElement>("input[name=q]")
  if (!form || !input || form.dataset.ready) return
  form.dataset.ready = "1"
  let timer: ReturnType<typeof setTimeout> | undefined
  const go = () => {
    const url = new URL(window.location.href)
    const q = input.value.trim()
    if (q) url.searchParams.set("q", q)
    else url.searchParams.delete("q")
    url.searchParams.delete("limit")
    for (const p of (form.dataset.listSearch ?? "").split(" ").filter(Boolean)) url.searchParams.delete(p)
    document.dispatchEvent(new CustomEvent("solidi:navigate-keep-scroll", { detail: url.pathname + url.search }))
  }
  input.addEventListener("input", () => {
    clearTimeout(timer)
    timer = setTimeout(go, 350)
  })
  form.addEventListener("submit", (e) => {
    e.preventDefault()
    clearTimeout(timer)
    go()
  })
}
setup()
document.addEventListener("astro:page-load", setup)
