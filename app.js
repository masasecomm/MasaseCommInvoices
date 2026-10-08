import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "./config.js";

const $ = (selector) => document.querySelector(selector);
const authPanel = $("#auth-panel");
const appPanel = $("#app-panel");
const authForm = $("#auth-form");
const authMessage = $("#auth-message");
const invoiceForm = $("#invoice-form");
const lineItems = $("#line-items");
const printView = $("#print-view");
const viewElements = [
  $("#overview-view"),
  $("#business-view"),
  $("#clients-view"),
  $("#dashboard-view"),
  $("#editor-view"),
  $("#business-form-view"),
];
const messages = [
  $("#auth-message"),
  $("#overview-message"),
  $("#business-message"),
  $("#clients-message"),
  $("#dashboard-message"),
  $("#editor-message"),
  $("#business-form-message"),
];

const LOGO_BUCKET = "business-logos";
const MAX_LOGO_BYTES = 2 * 1024 * 1024;
const LOGO_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/svg+xml"]);
const CLIENT_FIELD_IDS = ["saved-client-name", "saved-client-email", "saved-client-phone", "saved-client-address"];
const ALLOWED_ACCOUNT_EMAIL = "masasecomm@gmail.com";

let supabase;
let currentUser;
let businesses = [];
let clients = [];
let products = [];
let invoices = [];
let selectedBusinessId = null;
let activeView = "overview";
let editingId = null;
let editingBusinessId = null;
let pendingLogoFile = null;
let autosaveTimer = null;
let autosaveInProgress = false;
let autosaveQueued = false;
let suppressAutosave = false;
let editorGeneration = 0;
let invoiceNumberManuallyEdited = false;

function isConfigured() {
  return Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
}

function showMessage(element, message, success = false) {
  element.textContent = message;
  element.classList.toggle("success", success);
}

function clearMessages() {
  messages.forEach((element) => showMessage(element, ""));
}

function today() {
  const local = new Date();
  local.setMinutes(local.getMinutes() - local.getTimezoneOffset());
  return local.toISOString().slice(0, 10);
}

function nextDocumentNumber(type, issueDate = today(), clientId = "", businessId = selectedBusinessId) {
  if (type === "quote") {
    return `QUO-${new Date().getFullYear()}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  }
  const business = businesses.find((entry) => entry.id === businessId);
  if (!business) return `INV-${issueDate || today()}-1`;

  const client = clients.find((entry) => entry.id === clientId && entry.business_id === business.id);
  const matchingDocuments = invoices.filter((invoice) => {
    if (invoice.business_id !== business.id) return false;
    if (!client) return invoice.document_type === "invoice" && invoice.issue_date === (issueDate || today());
    return invoice.client_id === client.id || invoice.client_name.trim().toLowerCase() === client.name.trim().toLowerCase();
  });
  const clientSlug = client
    ? client.name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "") || "Client"
    : "";
  const prefix = client ? "INV-" : `INV-${issueDate || today()}-`;
  const numberedDocuments = client
    ? invoices.filter((invoice) => invoice.business_id === business.id)
    : matchingDocuments;
  const highestNumber = numberedDocuments.reduce((highest, invoice) => {
    const match = invoice.invoice_number.match(client
      ? /^INV-(.+)-(\d+)$/i
      : new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\d+)$`, "i"));
    if (!match) return highest;
    if (client && match[1].toLowerCase() !== clientSlug.slice(0, Math.max(1, 35 - match[2].length)).toLowerCase()) return highest;
    return Math.max(highest, Number(client ? match[2] : match[1]));
  }, 0);
  const previouslySent = client
    ? matchingDocuments.filter((invoice) => invoice.status === "sent" || invoice.status === "paid").length
    : matchingDocuments.length;
  const sequence = Math.max(highestNumber + 1, previouslySent + 1);
  if (!client) return `${prefix}${sequence}`;

  const name = clientSlug.slice(0, Math.max(1, 35 - String(sequence).length));
  return `INV-${name}-${sequence}`;
}

function refreshNewInvoiceNumber() {
  if (editingId || invoiceNumberManuallyEdited || $("#invoice-type").value === "quote") return;
  $("#invoice-number").value = nextDocumentNumber(
    $("#invoice-type").value,
    $("#issue-date").value,
    $("#client-picker").value,
  );
  renderEditorPreview();
}

function currencyAmount(amount, currency) {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(amount);
  } catch {
    return `${currency} ${Number(amount).toFixed(2)}`;
  }
}

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date);
}

function currentBusiness() {
  return businesses.find((business) => business.id === selectedBusinessId) || null;
}

function businessDocuments(businessId) {
  return invoices.filter((invoice) => invoice.business_id === businessId);
}

function businessClients(businessId) {
  return clients.filter((client) => client.business_id === businessId);
}

function invoiceAmounts(invoice) {
  const subtotal = invoice.items.reduce((sum, item) => sum + Number(item.quantity) * Number(item.unit_price), 0);
  const discountValue = Number(invoice.discount_value || 0);
  const discount = invoice.discount_type === "percent" ? subtotal * discountValue / 100 : discountValue;
  const taxable = subtotal - discount;
  const tax = taxable * Number(invoice.tax_rate || 0) / 100;
  return { subtotal, discount, taxable, tax, total: taxable + tax };
}

function invoiceTotal(invoice) {
  return invoiceAmounts(invoice).total;
}

function setView(view) {
  activeView = view;
  viewElements.forEach((element) => { element.hidden = element.id !== `${view}-view`; });
  ["overview", "business", "clients", "documents"].forEach((name) => {
    const button = $(`#nav-${name}`);
    if (button) button.classList.toggle("active", view === (name === "documents" ? "dashboard" : name));
  });
  clearMessages();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function updateBusinessSwitcher() {
  const select = $("#business-switcher");
  select.replaceChildren();
  if (!businesses.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "No businesses yet";
    select.append(option);
    select.disabled = true;
    return;
  }
  select.disabled = false;
  businesses.forEach((business) => {
    const option = document.createElement("option");
    option.value = business.id;
    option.textContent = business.name;
    select.append(option);
  });
  select.value = selectedBusinessId || businesses[0].id;
}

function setAuthenticated(user) {
  const previousUserId = currentUser?.id;
  currentUser = user;
  authPanel.hidden = Boolean(user);
  appPanel.hidden = !user;
  if (user) {
    $("#account-email").textContent = user.email || "";
    showMessage(authMessage, "");
    if (previousUserId !== user.id) {
      setView("overview");
      loadWorkspace();
    }
  } else {
    businesses = [];
    clients = [];
    products = [];
    invoices = [];
    selectedBusinessId = null;
    updateBusinessSwitcher();
    renderAll();
  }
}

async function applyAuthSession(session) {
  const user = session?.user || null;
  if (user && user.email?.toLowerCase() !== ALLOWED_ACCOUNT_EMAIL) {
    const { error } = await supabase.auth.signOut();
    setAuthenticated(null);
    showMessage(
      authMessage,
      error
        ? `This app is restricted to ${ALLOWED_ACCOUNT_EMAIL}. Sign-out also failed: ${error.message}`
        : `This app is restricted to ${ALLOWED_ACCOUNT_EMAIL}.`,
    );
    return;
  }
  setAuthenticated(user);
}

async function loadWorkspace() {
  if (!currentUser || !supabase) return;
  const [businessResult, clientResult, productResult, invoiceResult] = await Promise.all([
    supabase.from("businesses").select("*").order("created_at", { ascending: true }),
    supabase.from("clients").select("*").order("name", { ascending: true }),
    supabase.from("products").select("*").order("name", { ascending: true }),
    supabase.from("invoices").select("*").order("created_at", { ascending: false }),
  ]);
  const error = businessResult.error || clientResult.error || productResult.error || invoiceResult.error;
  if (error) {
    showMessage($("#overview-message"), `Could not load workspace: ${error.message}. Apply the latest setup in supabase/schema.sql, then reload.`);
    return;
  }
  const priorBusiness = selectedBusinessId;
  businesses = businessResult.data;
  clients = clientResult.data;
  products = productResult.data;
  invoices = invoiceResult.data;
  selectedBusinessId = businesses.some((business) => business.id === priorBusiness)
    ? priorBusiness
    : businesses[0]?.id || null;
  updateBusinessSwitcher();
  renderAll();
  populateProductOptions();
}

function appendText(parent, tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.textContent = text;
  parent.append(node);
  return node;
}

function appendImage(parent, url, className, alt) {
  if (!url) return null;
  const image = document.createElement("img");
  image.className = className;
  image.src = url;
  image.alt = alt;
  image.loading = "lazy";
  parent.append(image);
  return image;
}

function renderBarChart(container, entries, valueLabel = "Documents") {
  container.replaceChildren();
  if (!entries.length) {
    appendText(container, "p", "chart-empty", "Add businesses and documents to see activity here.");
    return;
  }
  const max = Math.max(1, ...entries.map((entry) => entry.value));
  entries.forEach((entry) => {
    const row = document.createElement("div");
    row.className = "bar-chart-row";
    const header = document.createElement("div");
    header.className = "bar-chart-label";
    appendText(header, "span", "", entry.label);
    appendText(header, "strong", "", `${entry.value} ${valueLabel.toLowerCase()}`);
    const track = document.createElement("div");
    track.className = "bar-track";
    const fill = document.createElement("span");
    fill.className = `bar-fill ${entry.color || ""}`;
    fill.style.width = `${Math.max(entry.value ? 7 : 0, entry.value / max * 100)}%`;
    track.append(fill);
    row.append(header, track);
    container.append(row);
  });
}

function businessDocumentsByPeriod(period) {
  const date = today();
  const periodPrefix = period === "year" ? date.slice(0, 4) : date.slice(0, 7);
  return businesses.map((business) => ({
    label: business.name,
    value: businessDocuments(business.id).filter((invoice) =>
      period === "today" ? invoice.issue_date === date : invoice.issue_date.startsWith(periodPrefix),
    ).length,
    color: "green",
  }));
}

function renderStatusChart(container, documents, includeQuotes = true) {
  const statuses = [
    { label: "Paid invoices", key: "paid", color: "green" },
    { label: "Sent invoices", key: "sent", color: "amber" },
    { label: "Draft invoices", key: "draft", color: "violet" },
  ];
  if (includeQuotes) statuses.push({ label: "Quotes", key: "quote", color: "blue", typeOnly: true });
  container.replaceChildren();
  const total = documents.length;
  if (!total) {
    appendText(container, "p", "chart-empty", "Quotes and invoices will show here as you create them.");
    return;
  }
  statuses.forEach((status) => {
    const count = status.typeOnly
      ? documents.filter((document) => document.document_type === status.key).length
      : documents.filter((document) => document.document_type === "invoice" && document.status === status.key).length;
    const row = document.createElement("div");
    row.className = "status-chart-row";
    const top = document.createElement("div");
    top.className = "status-chart-heading";
    const name = document.createElement("span");
    const dot = document.createElement("i");
    dot.className = `chart-dot ${status.color}`;
    name.append(dot, document.createTextNode(status.label));
    appendText(top, "strong", "", String(count));
    top.prepend(name);
    const track = document.createElement("div");
    track.className = "bar-track";
    const fill = document.createElement("span");
    fill.className = `bar-fill ${status.color}`;
    fill.style.width = `${Math.max(count ? 7 : 0, count / total * 100)}%`;
    track.append(fill);
    row.append(top, track);
    container.append(row);
  });
}

function renderOverview() {
  $("#overview-business-count").textContent = businesses.length;
  $("#overview-client-count").textContent = clients.length;
  $("#overview-quote-count").textContent = invoices.filter((invoice) => invoice.document_type === "quote").length;
  $("#overview-invoice-count").textContent = invoices.filter((invoice) => invoice.document_type === "invoice").length;
  const businessEntries = businesses.map((business) => ({
    label: business.name,
    value: businessDocuments(business.id).length,
    color: "green",
  }));
  renderBarChart($("#overview-business-chart"), businessEntries);
  renderBarChart($("#overview-business-today-chart"), businessDocumentsByPeriod("today"));
  renderBarChart($("#overview-business-month-chart"), businessDocumentsByPeriod("month"));
  renderBarChart($("#overview-business-year-chart"), businessDocumentsByPeriod("year"));
  renderStatusChart($("#overview-status-chart"), invoices);

  const cards = $("#overview-business-list");
  cards.replaceChildren();
  $("#overview-empty").hidden = businesses.length !== 0;
  businesses.forEach((business) => {
    const card = document.createElement("article");
    card.className = "business-card";
    const logo = business.logo_url
      ? appendImage(card, business.logo_url, "business-card-logo", `${business.name} logo`)
      : appendText(card, "span", "business-card-logo business-logo-fallback", business.name.trim().slice(0, 1).toUpperCase());
    const content = document.createElement("div");
    content.className = "business-card-content";
    appendText(content, "h3", "", business.name);
    appendText(content, "p", "", `${businessClients(business.id).length} clients · ${businessDocuments(business.id).length} documents`);
    const button = document.createElement("button");
    button.className = "business-card-open";
    button.type = "button";
    button.textContent = "Open dashboard →";
    button.dataset.openBusiness = business.id;
    card.append(content, button);
    if (logo && business.logo_url) logo.onerror = () => {
      logo.remove();
      const fallback = document.createElement("span");
      fallback.className = "business-card-logo business-logo-fallback";
      fallback.textContent = business.name.trim().slice(0, 1).toUpperCase();
      card.prepend(fallback);
    };
    cards.append(card);
  });
}

function renderDocumentRows(container, documents) {
  container.replaceChildren();
  documents.forEach((invoice) => {
    const row = document.createElement("tr");
    const type = document.createElement("td");
    const typePill = appendText(type, "span", `type-pill type-${invoice.document_type}`, invoice.document_type);
    typePill.title = invoice.document_type === "quote" ? "Quote" : "Invoice";
    const number = appendText(row, "td", "", invoice.invoice_number);
    const clientCell = document.createElement("td");
    const client = document.createElement("div");
    client.className = "client-cell";
    appendText(client, "span", "client-avatar", invoice.client_name.trim().slice(0, 1).toUpperCase());
    appendText(client, "span", "", invoice.client_name);
    clientCell.append(client);
    const issue = appendText(row, "td", "", formatDate(invoice.issue_date));
    const due = appendText(row, "td", "", formatDate(invoice.due_date));
    const amount = appendText(row, "td", "", currencyAmount(invoiceTotal(invoice), invoice.currency));
    const statusCell = document.createElement("td");
    appendText(statusCell, "span", `status-pill status-${invoice.status}`, invoice.status);
    const actions = document.createElement("td");
    const buttons = document.createElement("div");
    buttons.className = "row-actions";
    const labels = [["Edit", "edit"], ["Download PDF", "pdf"], ["Print", "print"], ["Email PDF", "send"]];
    if (invoice.document_type === "quote") labels.push(["Convert", "convert"]);
    labels.push(["Delete", "delete"]);
    labels.forEach(([label, action]) => {
      const button = document.createElement("button");
      button.className = `row-action${action === "delete" ? " row-action-delete" : ""}`;
      button.type = "button";
      button.textContent = label;
      button.dataset.action = action;
      button.dataset.id = invoice.id;
      buttons.append(button);
    });
    actions.append(buttons);
    row.prepend(type);
    row.append(clientCell, issue, due, amount, statusCell, actions);
    container.append(row);
    number.setAttribute("data-label", "Number");
  });
}

function renderDocuments() {
  const selected = businessDocuments(selectedBusinessId);
  const query = $("#invoice-search").value.trim().toLowerCase();
  const filtered = selected.filter((invoice) =>
    [invoice.invoice_number, invoice.client_name, invoice.client_email, invoice.status, invoice.document_type]
      .some((value) => (value || "").toLowerCase().includes(query)),
  );
  renderDocumentRows($("#invoice-rows"), filtered);
  const noSearchMatches = selected.length !== 0 && filtered.length === 0;
  $("#empty-state").hidden = filtered.length !== 0;
  $("#empty-title").textContent = noSearchMatches ? "No matching documents" : "Your first document starts here";
  $("#empty-description").textContent = noSearchMatches
    ? "Try another search term to find the document you need."
    : "Create a quote or invoice for this business to manage from any device.";
  $("#empty-new-invoice").hidden = noSearchMatches || !selectedBusinessId;
  $("#stat-total").textContent = selected.length;
  $("#stat-awaiting").textContent = selected.filter((document) => document.document_type === "invoice" && document.status === "sent").length;
  $("#stat-paid").textContent = selected.filter((document) => document.document_type === "invoice" && document.status === "paid").length;
}

function renderBusinessDocuments() {
  const documents = businessDocuments(selectedBusinessId);
  const query = $("#business-search").value.trim().toLowerCase();
  const filtered = documents.filter((invoice) =>
    [invoice.invoice_number, invoice.client_name, invoice.status, invoice.document_type]
      .some((value) => (value || "").toLowerCase().includes(query)),
  );
  renderDocumentRows($("#business-document-rows"), filtered);
  const noSearchMatches = documents.length !== 0 && filtered.length === 0;
  $("#business-documents-empty").hidden = filtered.length !== 0;
  $("#business-documents-empty h3").textContent = noSearchMatches ? "No matching documents" : "No documents yet";
  $("#business-documents-empty p").textContent = noSearchMatches
    ? "Try another search term to find the document you need."
    : "Create a quote or invoice for this business to get started.";
  $("#business-empty-new").hidden = noSearchMatches || !selectedBusinessId;
}

function renderBusinessDashboard() {
  const business = currentBusiness();
  if (!business) {
    $("#business-title").textContent = "No business selected";
    $("#business-subtitle").textContent = "Create a business profile to get started.";
    $("#business-logo").hidden = true;
    $("#business-logo-fallback").hidden = false;
    return;
  }
  $("#business-title").textContent = business.name;
  $("#business-subtitle").textContent = [business.email, business.address].filter(Boolean).join(" · ") || "Your business at a glance.";
  const logo = $("#business-logo");
  const fallback = $("#business-logo-fallback");
  if (business.logo_url) {
    logo.src = business.logo_url;
    logo.alt = `${business.name} logo`;
    logo.hidden = false;
    fallback.hidden = true;
    logo.onerror = () => { logo.hidden = true; fallback.hidden = false; };
  } else {
    logo.hidden = true;
    fallback.textContent = business.name.trim().slice(0, 1).toUpperCase();
    fallback.hidden = false;
  }
  const docs = businessDocuments(business.id);
  $("#business-client-count").textContent = businessClients(business.id).length;
  $("#business-quote-count").textContent = docs.filter((document) => document.document_type === "quote").length;
  $("#business-invoice-count").textContent = docs.filter((document) => document.document_type === "invoice").length;
  renderStatusChart($("#business-status-chart"), docs.filter((document) => document.document_type === "invoice"), false);
  const recent = $("#business-activity");
  recent.replaceChildren();
  const latest = [...docs].sort((a, b) => b.issue_date.localeCompare(a.issue_date)).slice(0, 5);
  if (!latest.length) appendText(recent, "p", "chart-empty", "Your recent quotes and invoices will appear here.");
  latest.forEach((invoice) => {
    const row = document.createElement("div");
    row.className = "activity-row";
    const icon = appendText(row, "span", `activity-icon ${invoice.document_type}`, invoice.document_type === "quote" ? "Q" : "I");
    const detail = document.createElement("div");
    detail.className = "activity-detail";
    appendText(detail, "strong", "", invoice.invoice_number);
    appendText(detail, "span", "", `${invoice.client_name} · ${formatDate(invoice.issue_date)}`);
    appendText(row, "strong", "activity-amount", currencyAmount(invoiceTotal(invoice), invoice.currency));
    row.prepend(icon, detail);
    recent.append(row);
  });
  renderBusinessDocuments();
}

function renderClients() {
  $("#clients-total").textContent = clients.length;
  $("#clients-business-count").textContent = new Set(clients.map((client) => client.business_id)).size;
  const query = $("#client-search").value.trim().toLowerCase();
  const matching = clients.filter((client) => {
    const business = businesses.find((entry) => entry.id === client.business_id);
    return [client.name, client.email, client.phone, business?.name]
      .some((value) => (value || "").toLowerCase().includes(query));
  });
  const container = $("#client-card-grid");
  container.replaceChildren();
  matching.forEach((client) => {
    const business = businesses.find((entry) => entry.id === client.business_id);
    const card = document.createElement("article");
    card.className = "client-card";
    appendText(card, "span", "client-card-avatar", client.name.trim().slice(0, 1).toUpperCase());
    const detail = document.createElement("div");
    detail.className = "client-card-detail";
    appendText(detail, "h3", "", client.name);
    appendText(detail, "span", "client-business-tag", business?.name || "Business");
    if (client.email) appendText(detail, "p", "", client.email);
    if (client.phone) appendText(detail, "p", "", client.phone);
    if (client.address) appendText(detail, "p", "client-address-text", client.address);
    const edit = document.createElement("button");
    edit.className = "row-action";
    edit.type = "button";
    edit.textContent = "Edit";
    edit.dataset.editClient = client.id;
    card.append(detail, edit);
    container.append(card);
  });
  $("#clients-empty").hidden = matching.length !== 0;
  if (query && !matching.length && clients.length) {
    $("#clients-empty").hidden = false;
    $("#clients-empty").querySelector("h3").textContent = "No matching clients";
    $("#clients-empty").querySelector("p").textContent = "Try another search term to find the client you need.";
    $("#clients-empty-add").hidden = true;
  } else {
    $("#clients-empty").querySelector("h3").textContent = "Your client directory is ready";
    $("#clients-empty").querySelector("p").textContent = "Save a client here and their contact details will be ready to use on quotes and invoices.";
    $("#clients-empty-add").hidden = false;
  }
  const businessSelect = $("#saved-client-business");
  const currentSelection = businessSelect.value || selectedBusinessId;
  businessSelect.replaceChildren();
  businesses.forEach((business) => {
    const option = document.createElement("option");
    option.value = business.id;
    option.textContent = business.name;
    businessSelect.append(option);
  });
  if (businesses.some((business) => business.id === currentSelection)) businessSelect.value = currentSelection;
}

function renderAll() {
  updateBusinessSwitcher();
  renderOverview();
  renderBusinessDashboard();
  renderClients();
  renderDocuments();
  populateClientPicker();
  setView(activeView);
}

function populateClientPicker(selectedId = "") {
  const picker = $("#client-picker");
  if (!picker) return;
  picker.replaceChildren();
  const manual = document.createElement("option");
  manual.value = "";
  manual.textContent = "Enter client details manually";
  picker.append(manual);
  businessClients(selectedBusinessId).forEach((client) => {
    const option = document.createElement("option");
    option.value = client.id;
    option.textContent = client.name;
    picker.append(option);
  });
  picker.value = selectedId;
}

function selectClient(clientId) {
  const client = clients.find((entry) => entry.id === clientId);
  $("#client-name").value = client?.name || "";
  $("#client-email").value = client?.email || "";
  $("#client-address").value = client?.address || "";
  refreshNewInvoiceNumber();
  scheduleAutosave();
  renderEditorPreview();
}

function businessProducts(businessId = selectedBusinessId) {
  return products.filter((product) => product.business_id === businessId);
}

function populateProductOptions() {
  const options = $("#product-options");
  if (!options) return;
  options.replaceChildren();
  businessProducts().forEach((product) => {
    const option = document.createElement("option");
    option.value = product.name;
    option.label = `${product.currency} ${Number(product.unit_price).toFixed(2)}`;
    options.append(option);
  });
}

function applySavedProduct(descriptionInput, priceInput) {
  const product = businessProducts().find((entry) =>
    entry.name.toLowerCase() === descriptionInput.value.trim().toLowerCase(),
  );
  if (product && product.currency === $("#currency").value.trim().toUpperCase()) {
    priceInput.value = product.unit_price;
  }
}

function createLineItem(item = { description: "", quantity: 1, unit_price: 0 }) {
  const row = document.createElement("div");
  row.className = "line-item";
  const description = document.createElement("input");
  description.className = "line-input";
  description.type = "text";
  description.placeholder = "Service or product";
  description.maxLength = 240;
  description.value = item.description || "";
  description.setAttribute("list", "product-options");
  description.setAttribute("aria-label", "Item description");
  const quantity = document.createElement("input");
  quantity.className = "line-input";
  quantity.type = "number";
  quantity.min = "0.01";
  quantity.step = "0.01";
  quantity.value = item.quantity ?? 1;
  quantity.setAttribute("aria-label", "Quantity");
  const price = document.createElement("input");
  price.className = "line-input";
  price.type = "number";
  price.min = "0";
  price.step = "0.01";
  price.value = item.unit_price ?? 0;
  price.setAttribute("aria-label", "Unit price");
  const amount = document.createElement("input");
  amount.className = "line-input line-input-amount";
  amount.type = "text";
  amount.readOnly = true;
  amount.tabIndex = -1;
  amount.setAttribute("aria-label", "Line amount");
  const remove = document.createElement("button");
  remove.className = "remove-line";
  remove.type = "button";
  remove.textContent = "×";
  remove.setAttribute("aria-label", "Remove line item");
  remove.addEventListener("click", () => {
    if (lineItems.children.length === 1) {
      description.value = "";
      quantity.value = "1";
      price.value = "0";
    } else {
      row.remove();
    }
    updateTotals();
    scheduleAutosave();
  });
  description.addEventListener("change", () => applySavedProduct(description, price));
  [description, quantity, price].forEach((input) => input.addEventListener("input", () => {
    if (input === description) applySavedProduct(description, price);
    updateTotals();
    scheduleAutosave();
  }));
  row.append(description, quantity, price, amount, remove);
  lineItems.append(row);
  updateTotals();
}

function formItems() {
  return [...lineItems.querySelectorAll(".line-item")].map((row) => {
    const [description, quantity, unitPrice] = row.querySelectorAll("input");
    return {
      description: description.value.trim(),
      quantity: Number(quantity.value),
      unit_price: Number(unitPrice.value),
    };
  });
}

function calculateFormAmounts() {
  const items = formItems();
  const subtotal = items.reduce((sum, item) =>
    sum + (Number.isFinite(item.quantity * item.unit_price) ? item.quantity * item.unit_price : 0), 0);
  const type = $("#discount-type").value;
  const value = Number($("#discount-value").value) || 0;
  const discount = type === "percent" ? subtotal * value / 100 : value;
  const taxable = subtotal - discount;
  const tax = taxable * (Number($("#tax-rate").value) || 0) / 100;
  return { subtotal, discount, taxable, tax, total: taxable + tax };
}

function updateTotals() {
  const currencyInput = $("#currency");
  const currency = currencyInput.value.trim().toUpperCase() || "ZAR";
  currencyInput.value = currency;
  $("#discount-suffix").textContent = $("#discount-type").value === "percent" ? "%" : currency;
  const amounts = calculateFormAmounts();
  $("#subtotal-value").textContent = currencyAmount(amounts.subtotal, currency);
  $("#discount-label").textContent = amounts.discount < 0 ? "Surcharge" : "Discount";
  $("#discount-amount-value").textContent = `${amounts.discount < 0 ? "+ " : "− "}${currencyAmount(Math.abs(amounts.discount), currency)}`;
  $("#tax-value").textContent = currencyAmount(amounts.tax, currency);
  $("#total-value").textContent = currencyAmount(amounts.total, currency);
  lineItems.querySelectorAll(".line-item").forEach((row) => {
    const [description, quantity, price, amount] = row.querySelectorAll("input");
    amount.value = currencyAmount((Number(quantity.value) || 0) * (Number(price.value) || 0), currency);
    description.setAttribute("aria-invalid", "false");
  });
  renderEditorPreview();
}

function renderEditorPreview() {
  const business = currentBusiness();
  const currency = $("#currency").value.trim().toUpperCase() || "ZAR";
  const items = formItems();
  const amounts = calculateFormAmounts();
  $("#preview-business-name").textContent = business?.name || "Your business";
  $("#preview-from-name").textContent = business?.name || "Your business";
  $("#preview-from-contact").textContent = [business?.email, business?.address].filter(Boolean).join(" · ");
  $("#preview-client-name").textContent = $("#client-name").value.trim() || "Client name";
  $("#preview-client-contact").textContent = [$("#client-email").value.trim(), $("#client-address").value.trim()].filter(Boolean).join(" · ");
  $("#preview-document-type").textContent = $("#invoice-type").value.toUpperCase();
  $("#preview-document-number").textContent = $("#invoice-number").value.trim() || "—";
  $("#preview-issue-date").textContent = formatDate($("#issue-date").value);
  $("#preview-due-label").textContent = $("#invoice-type").value === "quote" ? "VALID UNTIL" : "DUE DATE";
  $("#preview-due-date").textContent = formatDate($("#due-date").value);
  $("#preview-total").textContent = currencyAmount(amounts.total, currency);
  $("#preview-notes").textContent = $("#invoice-notes").value.trim();
  const previewItems = $("#preview-items");
  previewItems.replaceChildren();
  items.filter((item) => item.description.trim()).forEach((item) => {
    const row = document.createElement("div");
    row.className = "preview-item";
    appendText(row, "span", "", `${item.description} × ${item.quantity}`);
    appendText(row, "strong", "", currencyAmount(item.quantity * item.unit_price, currency));
    previewItems.append(row);
  });
  if (!previewItems.childElementCount) appendText(previewItems, "p", "preview-empty", "Your items will appear here.");
  const summary = $("#preview-summary");
  summary.replaceChildren();
  [
    ["Subtotal", amounts.subtotal],
    ...(amounts.discount ? [[amounts.discount < 0 ? "Surcharge" : "Discount", amounts.discount]] : []),
    [`Tax (${$("#tax-rate").value || 0}%)`, amounts.tax],
    ["Total", amounts.total],
  ].forEach(([label, amount]) => {
    const row = document.createElement("div");
    if (label === "Total") row.className = "preview-total-row";
    appendText(row, "span", "", label);
    const formatted = label === "Discount"
      ? `− ${currencyAmount(Math.abs(amount), currency)}`
      : label === "Surcharge"
        ? `+ ${currencyAmount(Math.abs(amount), currency)}`
        : currencyAmount(amount, currency);
    appendText(row, "strong", "", formatted);
    summary.append(row);
  });
}

function scheduleAutosave() {
  if (suppressAutosave || activeView !== "editor") return;
  $("#editor-save-status").textContent = "Unsaved changes";
  window.clearTimeout(autosaveTimer);
  autosaveTimer = window.setTimeout(() => saveInvoice({ automatic: true }), 900);
}

function updateTypeFields() {
  const type = $("#invoice-type").value;
  const isQuote = type === "quote";
  $("#editor-eyebrow").textContent = isQuote ? "NEW QUOTE" : "NEW INVOICE";
  $("#editor-title").textContent = `Create a ${type}`;
  $("#due-date-label").textContent = isQuote ? "Valid until" : "Due date";
  $("#invoice-status").querySelector('option[value="paid"]').disabled = isQuote;
  if (isQuote && $("#invoice-status").value === "paid") $("#invoice-status").value = "sent";
  if (!editingId && !invoiceNumberManuallyEdited && isQuote) {
    $("#invoice-number").value = nextDocumentNumber(type);
  } else {
    refreshNewInvoiceNumber();
  }
  $("#save-invoice").innerHTML = `Save ${type} <span aria-hidden="true">→</span>`;
  $("#mobile-save").innerHTML = `Save ${type} <span aria-hidden="true">→</span>`;
  renderEditorPreview();
  scheduleAutosave();
}

function showEditor(invoice = null, type = invoice?.document_type || "invoice") {
  clearMessages();
  if (!currentBusiness()) {
    showMessage($("#overview-message"), "Create or select a business before adding a quote or invoice.");
    setView("overview");
    return;
  }
  window.clearTimeout(autosaveTimer);
  editorGeneration += 1;
  suppressAutosave = true;
  editingId = invoice?.id || null;
  invoiceNumberManuallyEdited = Boolean(invoice);
  $("#invoice-type").value = invoice?.document_type || type;
  $("#editor-eyebrow").textContent = invoice ? `EDIT ${invoice.document_type.toUpperCase()}` : `NEW ${type.toUpperCase()}`;
  $("#editor-title").textContent = invoice ? `Edit ${invoice.document_type}` : `Create a ${type}`;
  $("#issue-date").value = invoice?.issue_date || today();
  $("#due-date").value = invoice?.due_date || today();
  $("#client-name").value = invoice?.client_name || "";
  $("#client-email").value = invoice?.client_email || "";
  $("#client-address").value = invoice?.client_address || "";
  $("#currency").value = invoice?.currency || "ZAR";
  $("#tax-rate").value = invoice?.tax_rate ?? 0;
  $("#discount-type").value = invoice?.discount_type || "amount";
  $("#discount-value").value = invoice?.discount_value ?? 0;
  $("#invoice-notes").value = invoice?.notes || "";
  $("#invoice-status").value = invoice?.status || "draft";
  populateClientPicker(invoice?.client_id || "");
  $("#invoice-number").value = invoice?.invoice_number || nextDocumentNumber(type, $("#issue-date").value);
  populateProductOptions();
  lineItems.replaceChildren();
  (invoice?.items?.length ? invoice.items : [{ description: "", quantity: 1, unit_price: 0 }]).forEach(createLineItem);
  $("#invoice-status").querySelector('option[value="paid"]').disabled = $("#invoice-type").value === "quote";
  $("#due-date-label").textContent = $("#invoice-type").value === "quote" ? "Valid until" : "Due date";
  $("#save-invoice").innerHTML = `Save ${$("#invoice-type").value} <span aria-hidden="true">→</span>`;
  $("#mobile-save").innerHTML = `Save ${$("#invoice-type").value} <span aria-hidden="true">→</span>`;
  setView("editor");
  $("#editor-save-status").textContent = invoice ? "Saved" : "Draft not saved";
  suppressAutosave = false;
  updateTotals();
}

function invoiceFromForm() {
  const items = formItems();
  if (!items.length || items.some((item) => !item.description || !Number.isFinite(item.quantity) || item.quantity <= 0 || !Number.isFinite(item.unit_price) || item.unit_price < 0)) {
    throw new Error("Add a description, a quantity greater than zero, and a valid unit price for each line item.");
  }
  const currency = $("#currency").value.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error("Enter a valid 3-letter currency code, such as ZAR or USD.");
  const taxRate = Number($("#tax-rate").value);
  if (!Number.isFinite(taxRate) || taxRate < 0 || taxRate > 100) throw new Error("Tax rate must be between 0 and 100 percent.");
  const discountType = $("#discount-type").value;
  const discountValue = Number($("#discount-value").value);
  if (!Number.isFinite(discountValue)) throw new Error("Enter a valid discount value.");
  if (discountType === "percent" && (discountValue < -100 || discountValue > 100)) {
    throw new Error("Percentage discounts and surcharges must be between -100% and 100%.");
  }
  const amounts = calculateFormAmounts();
  if (amounts.taxable < 0) throw new Error("A positive discount cannot exceed the line-item subtotal. Use a negative amount for a surcharge.");
  const issueDate = $("#issue-date").value;
  const dueDate = $("#due-date").value;
  if (!issueDate || !dueDate || dueDate < issueDate) throw new Error("The due date must be on or after the issue date.");
  const invoiceNumber = $("#invoice-number").value.trim();
  const business = currentBusiness();
  const clientName = $("#client-name").value.trim();
  if (!invoiceNumber || !business || !clientName) throw new Error("Document number, business, and client name are required.");
  if (!$("#client-email").checkValidity()) throw new Error("Enter a valid email address for the client.");
  const selectedClient = clients.find((client) => client.id === $("#client-picker").value);
  return {
    business_id: business.id,
    client_id: selectedClient?.id || null,
    document_type: $("#invoice-type").value,
    invoice_number: invoiceNumber,
    issuer_name: business.name,
    issuer_email: business.email,
    issuer_address: business.address,
    client_name: clientName,
    client_email: $("#client-email").value.trim() || null,
    client_address: $("#client-address").value.trim() || null,
    issue_date: issueDate,
    due_date: dueDate,
    currency,
    tax_rate: taxRate,
    discount_type: discountType,
    discount_value: discountValue,
    notes: $("#invoice-notes").value.trim() || null,
    status: $("#invoice-status").value,
    items,
  };
}

async function findOrSaveClient(invoice) {
  const existing = clients.find((client) =>
    client.business_id === invoice.business_id && client.name.toLowerCase() === invoice.client_name.toLowerCase(),
  );
  const clientValues = {
    user_id: currentUser.id,
    business_id: invoice.business_id,
    name: invoice.client_name,
    email: invoice.client_email,
    address: invoice.client_address,
  };
  const query = existing
    ? supabase.from("clients").update(clientValues).eq("id", existing.id).select().single()
    : supabase.from("clients").insert(clientValues).select().single();
  const { data, error } = await query;
  if (error) throw new Error(`Document was not saved. Could not save client: ${error.message}`);
  clients = existing
    ? clients.map((client) => client.id === data.id ? data : client)
    : [...clients, data];
  return { ...invoice, client_id: data.id };
}

async function saveProducts(invoice) {
  for (const item of invoice.items) {
    const existing = products.find((product) =>
      product.business_id === invoice.business_id &&
      product.name.toLowerCase() === item.description.toLowerCase() &&
      product.currency === invoice.currency,
    );
    const productValues = {
      user_id: currentUser.id,
      business_id: invoice.business_id,
      name: item.description,
      unit_price: item.unit_price,
      currency: invoice.currency,
    };
    const query = existing
      ? supabase.from("products").update(productValues).eq("id", existing.id).select().single()
      : supabase.from("products").insert(productValues).select().single();
    const { data, error } = await query;
    if (error) throw new Error(`Document was not saved. Could not save product "${item.description}": ${error.message}`);
    products = existing
      ? products.map((product) => product.id === data.id ? data : product)
      : [...products, data];
  }
  populateProductOptions();
}

async function saveInvoice({ automatic = false } = {}) {
  if (!automatic) window.clearTimeout(autosaveTimer);
  if (!automatic && !invoiceForm.reportValidity()) return;
  if (autosaveInProgress) {
    autosaveQueued = true;
    if (!automatic) showMessage($("#editor-message"), "A save is already in progress. Your latest changes will be saved next.");
    return;
  }
  let values;
  try {
    values = invoiceFromForm();
  } catch (error) {
    if (automatic) {
      $("#editor-save-status").textContent = "Complete required fields to autosave";
      return;
    }
    showMessage($("#editor-message"), error.message || "Could not save your document.");
    return;
  }

  const documentId = editingId;
  const generation = editorGeneration;
  const button = $("#save-invoice");
  const wasEditing = Boolean(documentId);
  autosaveInProgress = true;
  if (!automatic) {
    button.disabled = true;
    showMessage($("#editor-message"), "");
  } else {
    $("#editor-save-status").textContent = "Saving…";
  }
  try {
    const invoice = await findOrSaveClient(values);
    await saveProducts(invoice);
    const query = documentId
      ? supabase.from("invoices").update(invoice).eq("id", documentId).select().single()
      : supabase.from("invoices").insert({ ...invoice, user_id: currentUser.id }).select().single();
    const { data, error } = await query;
    if (error) throw error;
    if (!documentId && generation === editorGeneration && activeView === "editor") editingId = data.id;
    invoices = documentId
      ? invoices.map((entry) => entry.id === data.id ? data : entry)
      : [data, ...invoices];
    if (automatic && generation === editorGeneration && activeView === "editor") {
      $("#editor-save-status").textContent = "Saved automatically";
      showMessage($("#editor-message"), "");
    } else if (!automatic && generation === editorGeneration && activeView === "editor") {
      await loadWorkspace();
      if (generation === editorGeneration && activeView === "editor") {
        setView("business");
        showMessage($("#business-message"), wasEditing ? "Document updated." : "Document saved.", true);
      }
    }
  } catch (error) {
    if (automatic && generation === editorGeneration && activeView === "editor") {
      $("#editor-save-status").textContent = "Autosave failed";
      showMessage($("#editor-message"), error.message || "Could not save your document.");
    } else if (!automatic && generation === editorGeneration && activeView === "editor") {
      showMessage($("#editor-message"), error.message || "Could not save your document.");
    }
  } finally {
    autosaveInProgress = false;
    if (!automatic && generation === editorGeneration) button.disabled = false;
    if (autosaveQueued) {
      autosaveQueued = false;
      window.clearTimeout(autosaveTimer);
      autosaveTimer = window.setTimeout(() => saveInvoice({ automatic: true }), 0);
    }
  }
}

function renderPrint(invoice) {
  printView.replaceChildren();
  const page = document.createElement("article");
  page.className = "print-invoice";
  const header = document.createElement("header");
  header.className = "print-top";
  const identity = document.createElement("div");
  const business = businesses.find((entry) => entry.id === invoice.business_id);
  if (business?.logo_url) appendImage(identity, business.logo_url, "print-logo", `${business.name} logo`);
  appendText(identity, "div", "print-brand", invoice.issuer_name);
  header.append(identity);
  const title = document.createElement("div");
  appendText(title, "h1", "", invoice.document_type === "quote" ? "QUOTE" : "INVOICE");
  appendText(title, "div", "print-number", invoice.invoice_number);
  header.append(title);
  page.append(header);

  const details = document.createElement("section");
  details.className = "print-details";
  const from = document.createElement("div");
  appendText(from, "span", "print-label", "From");
  appendText(from, "p", "", invoice.issuer_name);
  if (invoice.issuer_email) appendText(from, "p", "", invoice.issuer_email);
  if (invoice.issuer_address) appendText(from, "p", "", invoice.issuer_address);
  const billTo = document.createElement("div");
  appendText(billTo, "span", "print-label", "Billed to");
  appendText(billTo, "p", "", invoice.client_name);
  if (invoice.client_email) appendText(billTo, "p", "", invoice.client_email);
  if (invoice.client_address) appendText(billTo, "p", "", invoice.client_address);
  details.append(from, billTo);
  page.append(details);
  const dateSection = document.createElement("section");
  dateSection.className = "print-dates";
  const issue = document.createElement("div");
  appendText(issue, "span", "print-label", "Issue date");
  appendText(issue, "p", "", formatDate(invoice.issue_date));
  const due = document.createElement("div");
  appendText(due, "span", "print-label", invoice.document_type === "quote" ? "Valid until" : "Due date");
  appendText(due, "p", "", formatDate(invoice.due_date));
  dateSection.append(issue, due);
  page.append(dateSection);

  const table = document.createElement("table");
  table.className = "print-table";
  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  ["Description", "Quantity", "Unit price", "Amount"].forEach((label) => appendText(headRow, "th", "", label));
  head.append(headRow);
  table.append(head);
  const body = document.createElement("tbody");
  invoice.items.forEach((item) => {
    const row = document.createElement("tr");
    appendText(row, "td", "", item.description);
    appendText(row, "td", "", String(item.quantity));
    appendText(row, "td", "", currencyAmount(item.unit_price, invoice.currency));
    appendText(row, "td", "", currencyAmount(item.quantity * item.unit_price, invoice.currency));
    body.append(row);
  });
  table.append(body);
  page.append(table);

  const amounts = invoiceAmounts(invoice);
  const summary = document.createElement("div");
  summary.className = "print-summary";
  const subtotalRow = document.createElement("div");
  appendText(subtotalRow, "span", "", "Subtotal");
  appendText(subtotalRow, "strong", "", currencyAmount(amounts.subtotal, invoice.currency));
  summary.append(subtotalRow);
  if (amounts.discount !== 0) {
    const discountRow = document.createElement("div");
    appendText(discountRow, "span", "", amounts.discount < 0 ? "Surcharge" : "Discount");
    appendText(discountRow, "strong", "", `${amounts.discount < 0 ? "+ " : "− "}${currencyAmount(Math.abs(amounts.discount), invoice.currency)}`);
    summary.append(discountRow);
  }
  const taxRow = document.createElement("div");
  appendText(taxRow, "span", "", `Tax (${invoice.tax_rate}%)`);
  appendText(taxRow, "strong", "", currencyAmount(amounts.tax, invoice.currency));
  summary.append(taxRow);
  const totalRow = document.createElement("div");
  totalRow.className = "print-grand";
  appendText(totalRow, "span", "", "Total");
  appendText(totalRow, "strong", "", currencyAmount(amounts.total, invoice.currency));
  summary.append(totalRow);
  page.append(summary);
  if (invoice.notes) {
    const notes = document.createElement("section");
    notes.className = "print-notes";
    appendText(notes, "span", "print-label", "Notes");
    appendText(notes, "p", "", invoice.notes);
    page.append(notes);
  }
  appendText(page, "p", "print-thanks", "Thank you for your business.");
  printView.append(page);
  document.body.classList.add("printing");
  window.print();
}

function pdfSafeText(value) {
  return String(value ?? "").normalize("NFKD").replace(/[^\x20-\x7E]/g, " ");
}

async function downloadInvoicePdf(invoice) {
  const { PDFDocument, StandardFonts, rgb } = await import("https://esm.sh/pdf-lib@1.17.1");
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  let page = pdf.addPage([595.28, 841.89]);
  const { width } = page.getSize();
  const left = 52;
  const right = width - 52;
  let y = 785;
  const green = rgb(0.19, 0.36, 0.27);

  const draw = (text, x, top, options = {}) => {
    const value = pdfSafeText(text);
    page.drawText(value, {
      x,
      y: top - (options.size || 10),
      size: options.size || 10,
      font: options.bold ? bold : font,
      color: options.color || rgb(0.16, 0.18, 0.16),
      maxWidth: options.maxWidth,
      lineHeight: options.lineHeight || 14,
    });
  };
  const wrapLines = (text, maxWidth, size) => {
    const lines = [];
    let line = "";
    pdfSafeText(text).split(/\s+/).forEach((word) => {
      const candidate = line ? `${line} ${word}` : word;
      if (line && font.widthOfTextAtSize(candidate, size) > maxWidth) {
        lines.push(line);
        line = word;
      } else {
        line = candidate;
      }
    });
    if (line) lines.push(line);
    return lines;
  };
  const ensureSpace = (needed = 30) => {
    if (y - needed < 55) {
      page = pdf.addPage([595.28, 841.89]);
      y = 785;
    }
  };
  const drawWrapped = (text, x, maxWidth, options = {}) => {
    const size = options.size || 10;
    const lines = wrapLines(text, maxWidth, size);
    lines.forEach((line) => {
      ensureSpace(size + 8);
      draw(line, x, y, { ...options, size });
      y -= size + 5;
    });
    return lines.length;
  };

  draw(invoice.issuer_name, left, y, { size: 20, bold: true, color: green });
  draw(invoice.document_type === "quote" ? "QUOTE" : "INVOICE", right - 120, y, { size: 23, bold: true, color: green });
  y -= 30;
  draw(invoice.invoice_number, right - 120, y, { size: 11 });
  y -= 18;
  page.drawLine({ start: { x: left, y }, end: { x: right, y }, thickness: 2, color: green });
  y -= 30;

  draw("FROM", left, y, { size: 8, bold: true, color: rgb(0.45, 0.48, 0.45) });
  draw("BILL TO", 310, y, { size: 8, bold: true, color: rgb(0.45, 0.48, 0.45) });
  y -= 16;
  const fromLines = [invoice.issuer_name, invoice.issuer_email, invoice.issuer_address].filter(Boolean)
    .flatMap((entry) => wrapLines(entry, 220, 10));
  const clientLines = [invoice.client_name, invoice.client_email, invoice.client_address].filter(Boolean)
    .flatMap((entry) => wrapLines(entry, 220, 10));
  const contactHeight = Math.max(fromLines.length, clientLines.length) * 14;
  ensureSpace(contactHeight + 52);
  const contactTop = y;
  fromLines.forEach((line, index) => draw(line, left, contactTop - index * 14));
  clientLines.forEach((line, index) => draw(line, 310, contactTop - index * 14));
  y = contactTop - contactHeight - 18;
  draw(`${invoice.document_type === "quote" ? "Valid until" : "Due date"}: ${formatDate(invoice.due_date)}`, left, y);
  draw(`Issue date: ${formatDate(invoice.issue_date)}`, 310, y);
  y -= 32;

  const drawItemsHeader = () => {
    page.drawRectangle({ x: left, y: y - 5, width: right - left, height: 22, color: rgb(0.95, 0.96, 0.95) });
    draw("DESCRIPTION", left + 8, y + 10, { size: 8, bold: true });
    draw("QTY", 350, y + 10, { size: 8, bold: true });
    draw("UNIT PRICE", 395, y + 10, { size: 8, bold: true });
    draw("AMOUNT", 495, y + 10, { size: 8, bold: true });
    y -= 22;
  };
  drawItemsHeader();
  invoice.items.forEach((item) => {
    const descriptionLines = wrapLines(item.description, 265, 9);
    const rowHeight = Math.max(18, descriptionLines.length * 14);
    if (y - rowHeight < 55) {
      page = pdf.addPage([595.28, 841.89]);
      y = 785;
      drawItemsHeader();
    }
    descriptionLines.forEach((line, index) => draw(line, left + 8, y - index * 14, { size: 9 }));
    draw(String(item.quantity), 350, y, { size: 9 });
    draw(pdfSafeText(currencyAmount(item.unit_price, invoice.currency)), 395, y, { size: 9 });
    draw(pdfSafeText(currencyAmount(item.quantity * item.unit_price, invoice.currency)), 495, y, { size: 9 });
    y -= rowHeight;
    page.drawLine({ start: { x: left, y: y + 5 }, end: { x: right, y: y + 5 }, thickness: 0.5, color: rgb(0.9, 0.91, 0.9) });
  });
  y -= 14;
  const amounts = invoiceAmounts(invoice);
  const summaryRows = [
    ["Subtotal", amounts.subtotal],
    ...(amounts.discount !== 0 ? [[amounts.discount < 0 ? "Surcharge" : "Discount", amounts.discount]] : []),
    [`Tax (${invoice.tax_rate}%)`, amounts.tax],
  ];
  summaryRows.forEach(([label, amount]) => {
    ensureSpace(22);
    draw(label, 350, y, { size: 10 });
    const formatted = label === "Discount"
      ? `- ${currencyAmount(Math.abs(amount), invoice.currency)}`
      : label === "Surcharge"
        ? `+ ${currencyAmount(Math.abs(amount), invoice.currency)}`
        : currencyAmount(amount, invoice.currency);
    draw(pdfSafeText(formatted), 450, y, { size: 10 });
    y -= 20;
  });
  ensureSpace(34);
  page.drawLine({ start: { x: 350, y: y + 6 }, end: { x: right, y: y + 6 }, thickness: 1, color: green });
  draw("TOTAL", 350, y - 2, { size: 12, bold: true, color: green });
  draw(pdfSafeText(currencyAmount(amounts.total, invoice.currency)), 450, y - 2, { size: 12, bold: true, color: green });
  y -= 38;
  if (invoice.notes) {
    ensureSpace(40);
    draw("NOTES", left, y, { size: 8, bold: true, color: rgb(0.45, 0.48, 0.45) });
    y -= 15;
    drawWrapped(invoice.notes, left, right - left, { size: 10 });
  }
  const bytes = await pdf.save();
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `${pdfSafeText(invoice.document_type)}-${pdfSafeText(invoice.invoice_number).replace(/[^a-zA-Z0-9_-]/g, "-")}.pdf`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function downloadEditorPdf() {
  try {
    const invoice = invoiceFromForm();
    await downloadInvoicePdf(invoice);
    showMessage($("#editor-message"), "PDF downloaded.", true);
  } catch (error) {
    showMessage($("#editor-message"), error.message || "Could not create the PDF.");
  }
}

async function handleDocumentAction(event) {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const invoice = invoices.find((item) => item.id === button.dataset.id);
  if (!invoice) return;
  if (button.dataset.action === "send") {
    const message = activeView === "dashboard" ? $("#dashboard-message") : $("#business-message");
    if (!invoice.client_email) {
      showMessage(message, "Add an email address to this client before sending the document.");
      return;
    }
    button.disabled = true;
    button.textContent = "Sending...";
    showMessage(message, "");
    try {
      const { data, error } = await supabase.functions.invoke("send-document-email", {
        body: { invoice_id: invoice.id },
      });
      if (error) {
        let details = data?.error || error.message;
        if (error.context instanceof Response) {
          const responseText = await error.context.text();
          try {
            details = JSON.parse(responseText).error || details;
          } catch {
            details = `Email function error: ${error.context.status} ${error.context.statusText}`;
          }
        }
        throw new Error(details || "The email could not be sent.");
      }
      await loadWorkspace();
      showMessage(message, data?.message || `PDF sent to ${invoice.client_email}.`, true);
    } catch (error) {
      showMessage(message, error.message || "The email could not be sent.");
    } finally {
      button.disabled = false;
      button.textContent = "Email PDF";
    }
  } else if (button.dataset.action === "edit") {
    selectedBusinessId = invoice.business_id;
    updateBusinessSwitcher();
    showEditor(invoice);
  } else if (button.dataset.action === "print") {
    renderPrint(invoice);
  } else if (button.dataset.action === "pdf") {
    const message = activeView === "dashboard" ? $("#dashboard-message") : $("#business-message");
    button.disabled = true;
    try {
      await downloadInvoicePdf(invoice);
      showMessage(message, "PDF downloaded.", true);
    } catch (error) {
      showMessage(message, error.message || "Could not create the PDF.");
    } finally {
      button.disabled = false;
    }
  } else if (button.dataset.action === "convert" && invoice.document_type === "quote") {
    const { error } = await supabase.from("invoices").update({
      document_type: "invoice",
      invoice_number: nextDocumentNumber("invoice", invoice.issue_date, invoice.client_id, invoice.business_id),
      status: "draft",
    }).eq("id", invoice.id);
    if (error) {
      showMessage(activeView === "dashboard" ? $("#dashboard-message") : $("#business-message"), `Could not convert quote: ${error.message}`);
      return;
    }
    await loadWorkspace();
    const message = activeView === "dashboard" ? $("#dashboard-message") : $("#business-message");
    showMessage(message, "Quote converted to a new draft invoice.", true);
  } else if (button.dataset.action === "delete") {
    if (!window.confirm(`Delete ${invoice.document_type} ${invoice.invoice_number}? This cannot be undone.`)) return;
    const { error } = await supabase.from("invoices").delete().eq("id", invoice.id);
    if (error) {
      showMessage(activeView === "dashboard" ? $("#dashboard-message") : $("#business-message"), `Could not delete document: ${error.message}`);
      return;
    }
    await loadWorkspace();
    showMessage(activeView === "dashboard" ? $("#dashboard-message") : $("#business-message"), "Document deleted.", true);
  }
}

function resetBusinessForm(business = null) {
  editingBusinessId = business?.id || null;
  pendingLogoFile = null;
  $("#business-edit-id").value = business?.id || "";
  $("#profile-business-name").value = business?.name || "";
  $("#profile-business-email").value = business?.email || "";
  $("#profile-business-address").value = business?.address || "";
  $("#business-logo-file").value = "";
  $("#business-form-eyebrow").textContent = business ? "EDIT BUSINESS" : "BUSINESS PROFILE";
  $("#business-form-heading").textContent = business ? "Edit business" : "Create a business";
  $("#save-business").innerHTML = business ? "Save changes <span aria-hidden=\"true\">→</span>" : "Save business <span aria-hidden=\"true\">→</span>";
  const preview = $("#business-logo-preview");
  const placeholder = $("#business-logo-placeholder");
  if (business?.logo_url) {
    preview.src = business.logo_url;
    preview.hidden = false;
    placeholder.hidden = true;
  } else {
    preview.removeAttribute("src");
    preview.hidden = true;
    placeholder.hidden = false;
    placeholder.textContent = business?.name?.slice(0, 1).toUpperCase() || "M";
  }
  setView("business-form");
}

async function saveBusiness(event) {
  event.preventDefault();
  if (!$("#business-form").reportValidity()) return;
  const button = $("#save-business");
  button.disabled = true;
  showMessage($("#business-form-message"), "");
  try {
    const values = {
      name: $("#profile-business-name").value.trim(),
      email: $("#profile-business-email").value.trim() || null,
      address: $("#profile-business-address").value.trim() || null,
    };
    const result = editingBusinessId
      ? await supabase.from("businesses").update(values).eq("id", editingBusinessId).select().single()
      : await supabase.from("businesses").insert({ ...values, user_id: currentUser.id }).select().single();
    if (result.error) throw result.error;
    const savedBusiness = result.data;
    if (pendingLogoFile) {
      const extension = pendingLogoFile.name.split(".").pop().toLowerCase();
      const path = `${currentUser.id}/${savedBusiness.id}/logo.${extension}`;
      const { error: uploadError } = await supabase.storage.from(LOGO_BUCKET).upload(path, pendingLogoFile, {
        upsert: true,
        contentType: pendingLogoFile.type,
      });
      if (uploadError) {
        await loadWorkspace();
        throw new Error(`Business saved, but the logo could not be uploaded: ${uploadError.message}`);
      }
      const { data: publicUrl } = supabase.storage.from(LOGO_BUCKET).getPublicUrl(path);
      const { error: updateError } = await supabase.from("businesses").update({ logo_url: publicUrl.publicUrl }).eq("id", savedBusiness.id);
      if (updateError) throw new Error(`Logo uploaded, but the business profile could not be updated: ${updateError.message}`);
    }
    selectedBusinessId = savedBusiness.id;
    await loadWorkspace();
    setView("business");
    showMessage($("#business-message"), editingBusinessId ? "Business updated." : "Business created.", true);
  } catch (error) {
    showMessage($("#business-form-message"), error.message || "Could not save the business.");
  } finally {
    button.disabled = false;
  }
}

function resetClientForm(client = null) {
  if (!client && !businesses.length) {
    resetBusinessForm();
    showMessage($("#business-form-message"), "Create a business profile before adding clients.");
    return;
  }
  $("#client-form").reset();
  $("#client-edit-id").value = client?.id || "";
  $("#client-form-title").textContent = client ? "Edit client" : "Add a client";
  $("#saved-client-business").value = client?.business_id || selectedBusinessId || businesses[0]?.id || "";
  $("#saved-client-name").value = client?.name || "";
  $("#saved-client-email").value = client?.email || "";
  $("#saved-client-phone").value = client?.phone || "";
  $("#saved-client-address").value = client?.address || "";
  $("#client-form-panel").hidden = false;
  $("#saved-client-name").focus();
}

async function saveClient(event) {
  event.preventDefault();
  if (!$("#client-form").reportValidity()) return;
  const id = $("#client-edit-id").value;
  const values = {
    business_id: $("#saved-client-business").value,
    name: $("#saved-client-name").value.trim(),
    email: $("#saved-client-email").value.trim() || null,
    phone: $("#saved-client-phone").value.trim() || null,
    address: $("#saved-client-address").value.trim() || null,
  };
  const result = id
    ? await supabase.from("clients").update(values).eq("id", id).select().single()
    : await supabase.from("clients").insert({ ...values, user_id: currentUser.id }).select().single();
  if (result.error) {
    showMessage($("#clients-message"), `Could not save client: ${result.error.message}`);
    return;
  }
  $("#client-form-panel").hidden = true;
  await loadWorkspace();
  setView("clients");
  showMessage($("#clients-message"), id ? "Client updated." : "Client saved.", true);
}

async function handleAuth(event) {
  event.preventDefault();
  if (!isConfigured()) {
    showMessage(authMessage, "Add your Supabase project URL and publishable anon key to config.js before signing in.");
    return;
  }
  const button = $("#auth-submit");
  button.disabled = true;
  showMessage(authMessage, "");
  try {
    const email = $("#auth-email").value.trim();
    if (email.toLowerCase() !== ALLOWED_ACCOUNT_EMAIL) {
      throw new Error(`Only ${ALLOWED_ACCOUNT_EMAIL} can sign in to this app.`);
    }
    const password = $("#auth-password").value;
    const result = await supabase.auth.signInWithPassword({ email, password });
    if (result.error) throw result.error;
  } catch (error) {
    showMessage(authMessage, error.message || "Could not complete sign-in.");
  } finally {
    button.disabled = false;
  }
}

function startNewDocument(type = "invoice") {
  if (!currentBusiness()) {
    resetBusinessForm();
    showMessage($("#business-form-message"), "Create a business profile before adding documents.");
    return;
  }
  showEditor(null, type);
}

authForm.addEventListener("submit", handleAuth);
$("#nav-overview").addEventListener("click", () => setView("overview"));
$("#nav-business").addEventListener("click", () => {
  if (!currentBusiness()) setView("overview");
  else setView("business");
});
$("#nav-clients").addEventListener("click", () => setView("clients"));
$("#nav-documents").addEventListener("click", () => {
  if (!currentBusiness()) setView("overview");
  else setView("dashboard");
});
$("#business-switcher").addEventListener("change", (event) => {
  selectedBusinessId = event.target.value;
  renderAll();
  if (activeView === "overview" || activeView === "business" || activeView === "dashboard") {
    setView(activeView === "dashboard" ? "dashboard" : "business");
  }
});
$("#add-business").addEventListener("click", () => resetBusinessForm());
$("#overview-add-business").addEventListener("click", () => resetBusinessForm());
$("#overview-create-first").addEventListener("click", () => resetBusinessForm());
$("#edit-business").addEventListener("click", () => resetBusinessForm(currentBusiness()));
$("#business-form").addEventListener("submit", saveBusiness);
$("#business-logo-file").addEventListener("change", (event) => {
  const file = event.target.files[0];
  if (!file) return;
  if (!LOGO_TYPES.has(file.type)) {
    showMessage($("#business-form-message"), "Choose a PNG, JPEG, WebP, or SVG logo.");
    event.target.value = "";
    return;
  }
  if (file.size > MAX_LOGO_BYTES) {
    showMessage($("#business-form-message"), "Logo files must be 2 MB or smaller.");
    event.target.value = "";
    return;
  }
  pendingLogoFile = file;
  const preview = $("#business-logo-preview");
  preview.src = URL.createObjectURL(file);
  preview.hidden = false;
  $("#business-logo-placeholder").hidden = true;
  showMessage($("#business-form-message"), "");
});
$("#cancel-business-form").addEventListener("click", () => setView(editingBusinessId ? "business" : "overview"));
$("#cancel-business-form-top").addEventListener("click", () => setView(editingBusinessId ? "business" : "overview"));
$("#overview-new-document").addEventListener("click", () => startNewDocument());
$("#business-new-document").addEventListener("click", () => startNewDocument());
$("#business-empty-new").addEventListener("click", () => startNewDocument());
$("#new-invoice").addEventListener("click", () => startNewDocument());
$("#empty-new-invoice").addEventListener("click", () => startNewDocument());
$("#overview-business-list").addEventListener("click", (event) => {
  const button = event.target.closest("[data-open-business]");
  if (!button) return;
  selectedBusinessId = button.dataset.openBusiness;
  updateBusinessSwitcher();
  renderAll();
  setView("business");
});
$("#show-client-form").addEventListener("click", () => resetClientForm());
$("#clients-empty-add").addEventListener("click", () => resetClientForm());
$("#cancel-client-form").addEventListener("click", () => { $("#client-form-panel").hidden = true; });
$("#cancel-client").addEventListener("click", () => { $("#client-form-panel").hidden = true; });
$("#client-form").addEventListener("submit", saveClient);
$("#client-search").addEventListener("input", renderClients);
$("#client-card-grid").addEventListener("click", (event) => {
  const button = event.target.closest("[data-edit-client]");
  if (!button) return;
  const client = clients.find((entry) => entry.id === button.dataset.editClient);
  if (client) resetClientForm(client);
});
$("#client-picker").addEventListener("change", (event) => selectClient(event.target.value));
$("#client-name").addEventListener("input", () => {
  const selected = clients.find((client) => client.id === $("#client-picker").value);
  if (selected && selected.name !== $("#client-name").value.trim()) {
    $("#client-picker").value = "";
    refreshNewInvoiceNumber();
  }
});
$("#invoice-type").addEventListener("change", updateTypeFields);
$("#issue-date").addEventListener("input", refreshNewInvoiceNumber);
$("#issue-date").addEventListener("change", refreshNewInvoiceNumber);
$("#invoice-number").addEventListener("input", () => {
  invoiceNumberManuallyEdited = true;
});
$("#invoice-search").addEventListener("input", renderDocuments);
$("#business-search").addEventListener("input", (event) => {
  renderBusinessDocuments();
});
$("#business-document-rows").addEventListener("click", handleDocumentAction);
$("#invoice-rows").addEventListener("click", handleDocumentAction);
$("#back-to-dashboard").addEventListener("click", () => setView("dashboard"));
$("#cancel-edit").addEventListener("click", () => setView("business"));
$("#mobile-cancel").addEventListener("click", () => setView("business"));
$("#save-invoice").addEventListener("click", saveInvoice);
$("#mobile-save").addEventListener("click", saveInvoice);
["download-editor-pdf", "preview-download-pdf", "mobile-download-pdf"].forEach((id) =>
  $(`#${id}`).addEventListener("click", downloadEditorPdf),
);
$("#add-line").addEventListener("click", () => createLineItem());
$("#tax-rate").addEventListener("input", updateTotals);
$("#discount-type").addEventListener("change", updateTotals);
$("#discount-value").addEventListener("input", updateTotals);
$("#currency").addEventListener("input", updateTotals);
invoiceForm.addEventListener("input", () => {
  renderEditorPreview();
  scheduleAutosave();
});
invoiceForm.addEventListener("change", () => {
  renderEditorPreview();
  scheduleAutosave();
});
invoiceForm.addEventListener("submit", (event) => event.preventDefault());
$("#sign-out").addEventListener("click", async () => {
  const { error } = await supabase.auth.signOut();
  if (error) showMessage($("#overview-message"), `Could not sign out: ${error.message}`);
  else setAuthenticated(null);
});
window.addEventListener("afterprint", () => document.body.classList.remove("printing"));

if (!isConfigured()) {
  $("#setup-notice").hidden = false;
  $("#setup-notice").textContent = "Cloud sync is almost ready. Add your Supabase project URL and publishable anon key in config.js, and apply the database setup in supabase/schema.sql.";
} else {
  supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  supabase.auth.onAuthStateChange((_event, session) => {
    window.setTimeout(() => { applyAuthSession(session); }, 0);
  });
  supabase.auth.getSession().then(({ data, error }) => {
    if (error) showMessage(authMessage, `Could not restore your session: ${error.message}`);
    applyAuthSession(data?.session || null);
  });
}
