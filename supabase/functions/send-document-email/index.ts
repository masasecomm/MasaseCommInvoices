import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { PDFDocument, StandardFonts, rgb, type PDFFont } from "npm:pdf-lib@1.17.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type LineItem = {
  description: string;
  quantity: number;
  unit_price: number;
};

type Invoice = {
  id: string;
  user_id: string;
  business_id: string;
  invoice_number: string;
  document_type: "quote" | "invoice";
  issuer_name: string;
  issuer_email: string | null;
  issuer_address: string | null;
  client_name: string;
  client_email: string | null;
  client_address: string | null;
  issue_date: string;
  due_date: string;
  currency: string;
  tax_rate: number;
  discount_type: "amount" | "percent";
  discount_value: number;
  notes: string | null;
  status: "draft" | "sent" | "paid";
  items: LineItem[];
};

type Business = {
  name: string;
  email: string | null;
  address: string | null;
};

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character] || character);
}

function pdfSafe(value: string) {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^\x20-\x7e]/g, "?");
}

function calculateAmounts(invoice: Invoice) {
  const subtotal = invoice.items.reduce((sum, item) => sum + item.quantity * item.unit_price, 0);
  const discount = invoice.discount_type === "percent"
    ? subtotal * invoice.discount_value / 100
    : invoice.discount_value;
  const taxable = subtotal - discount;
  const tax = taxable * invoice.tax_rate / 100;
  return { subtotal, discount, tax, total: taxable + tax };
}

function money(value: number, currency: string) {
  return `${currency} ${value.toFixed(2)}`;
}

function wrapText(text: string, maxWidth: number, size: number, font: PDFFont) {
  const words = pdfSafe(text).split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      line = candidate;
      continue;
    }
    if (line) lines.push(line);
    line = "";
    for (const character of word) {
      const next = line + character;
      if (font.widthOfTextAtSize(next, size) > maxWidth && line) {
        lines.push(line);
        line = character;
      } else {
        line = next;
      }
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [""];
}

async function createPdf(invoice: Invoice, business: Business) {
  const pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const pageSize: [number, number] = [595.28, 841.89];
  const margin = 48;
  const right = pageSize[0] - margin;
  const textColor = rgb(0.12, 0.17, 0.14);
  const mutedColor = rgb(0.39, 0.43, 0.4);
  const accentColor = rgb(0.16, 0.38, 0.25);
  let page = pdf.addPage(pageSize);
  let y = pageSize[1] - margin;

  const draw = (text: string, x: number, top: number, size = 10, font = regular, color = textColor) => {
    page.drawText(pdfSafe(text), { x, y: top - size, size, font, color });
  };
  const drawWrapped = (text: string, x: number, top: number, width: number, size = 10, font = regular) => {
    const lines = wrapText(text, width, size, font);
    lines.forEach((line, index) => draw(line, x, top - index * (size + 3), size, font));
    return lines.length * (size + 3);
  };
  const nextPage = () => {
    page = pdf.addPage(pageSize);
    y = pageSize[1] - margin;
  };
  const ensureSpace = (height: number) => {
    if (y - height < margin) nextPage();
  };
  const drawTableHeader = () => {
    ensureSpace(28);
    page.drawLine({ start: { x: margin, y: y - 5 }, end: { x: right, y: y - 5 }, thickness: 1, color: accentColor });
    draw("Description", margin, y - 10, 9, bold);
    draw("Qty", 342, y - 10, 9, bold);
    draw("Unit price", 385, y - 10, 9, bold);
    draw("Amount", 478, y - 10, 9, bold);
    y -= 28;
  };

  draw(invoice.document_type === "quote" ? "QUOTE" : "INVOICE", margin, y, 11, bold, accentColor);
  draw(invoice.invoice_number, margin, y - 22, 22, bold);
  const businessLines = wrapText(business.name || invoice.issuer_name, right - margin, 12, bold);
  businessLines.forEach((line, index) => {
    draw(line, right - bold.widthOfTextAtSize(line, 12), y - 2 - index * 15, 12, bold);
  });
  y -= 65;

  const columnWidth = 235;
  draw("FROM", margin, y, 8, bold, mutedColor);
  draw("BILL TO", margin + columnWidth + 25, y, 8, bold, mutedColor);
  y -= 17;
  let leftHeight = drawWrapped(invoice.issuer_name, margin, y, columnWidth, 10, bold);
  let rightHeight = drawWrapped(invoice.client_name, margin + columnWidth + 25, y, columnWidth, 10, bold);
  if (invoice.issuer_email) leftHeight += drawWrapped(invoice.issuer_email, margin, y - leftHeight, columnWidth, 9);
  if (invoice.client_email) rightHeight += drawWrapped(invoice.client_email, margin + columnWidth + 25, y - rightHeight, columnWidth, 9);
  if (invoice.issuer_address) leftHeight += drawWrapped(invoice.issuer_address, margin, y - leftHeight, columnWidth, 9);
  if (invoice.client_address) rightHeight += drawWrapped(invoice.client_address, margin + columnWidth + 25, y - rightHeight, columnWidth, 9);
  y -= Math.max(leftHeight, rightHeight) + 22;

  draw("Issue date", margin, y, 8, bold, mutedColor);
  draw(invoice.issue_date, margin, y - 14);
  draw(invoice.document_type === "quote" ? "Valid until" : "Due date", margin + 180, y, 8, bold, mutedColor);
  draw(invoice.due_date, margin + 180, y - 14);
  y -= 48;
  drawTableHeader();

  for (const item of invoice.items) {
    const descriptionLines = wrapText(item.description, 270, 9, regular);
    const rowHeight = Math.max(22, descriptionLines.length * 12 + 8);
    ensureSpace(rowHeight + 4);
    descriptionLines.forEach((line, index) => draw(line, margin, y - 3 - index * 12, 9));
    draw(String(item.quantity), 342, y - 3, 9);
    draw(money(item.unit_price, invoice.currency), 385, y - 3, 9);
    draw(money(item.quantity * item.unit_price, invoice.currency), 478, y - 3, 9);
    y -= rowHeight;
  }

  const amounts = calculateAmounts(invoice);
  ensureSpace(112 + (invoice.notes ? 62 : 0));
  page.drawLine({ start: { x: margin, y }, end: { x: right, y }, thickness: 0.5, color: mutedColor });
  y -= 20;
  const summary = (label: string, value: string, strong = false) => {
    draw(label, 365, y, 9, strong ? bold : regular);
    draw(value, 465, y, 9, strong ? bold : regular);
    y -= 17;
  };
  summary("Subtotal", money(amounts.subtotal, invoice.currency));
  if (amounts.discount !== 0) {
    summary(amounts.discount < 0 ? "Surcharge" : "Discount", `${amounts.discount < 0 ? "+ " : "- "}${money(Math.abs(amounts.discount), invoice.currency)}`);
  }
  summary(`Tax (${invoice.tax_rate}%)`, money(amounts.tax, invoice.currency));
  summary("Total", money(amounts.total, invoice.currency), true);

  if (invoice.notes) {
    y -= 12;
    draw("NOTES", margin, y, 8, bold, mutedColor);
    y -= 15;
    const lines = wrapText(invoice.notes, right - margin, 9, regular);
    for (const line of lines) {
      ensureSpace(16);
      draw(line, margin, y, 9);
      y -= 13;
    }
  }
  return await pdf.save();
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return jsonResponse({ error: "Method not allowed." }, 405);

  const authorization = request.headers.get("Authorization");
  const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return jsonResponse({ error: "Please sign in before sending a document." }, 401);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SUPABASE_PUBLISHABLE_KEY");
  const resendApiKey = Deno.env.get("RESEND_API_KEY");
  const emailFrom = Deno.env.get("EMAIL_FROM");
  if (!supabaseUrl || !supabaseAnonKey) {
    return jsonResponse({ error: "The Supabase function is missing its project configuration." }, 500);
  }
  if (!resendApiKey || !emailFrom) {
    return jsonResponse({ error: "Email sending is not configured yet. Add the Resend API key and verified sender address to Supabase function secrets." }, 503);
  }

  let body: { invoice_id?: string };
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "The request body must be valid JSON." }, 400);
  }
  if (!body.invoice_id || !/^[0-9a-f-]{36}$/i.test(body.invoice_id)) {
    return jsonResponse({ error: "A valid document ID is required." }, 400);
  }

  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userError } = await supabase.auth.getUser(token);
  if (userError || !userData.user) return jsonResponse({ error: "Your session has expired. Please sign in again." }, 401);

  const { data: invoice, error: invoiceError } = await supabase
    .from("invoices")
    .select("*")
    .eq("id", body.invoice_id)
    .eq("user_id", userData.user.id)
    .single();
  if (invoiceError || !invoice) return jsonResponse({ error: "Document not found or you do not have permission to send it." }, 404);

  const document = invoice as Invoice;
  if (!document.client_email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(document.client_email)) {
    return jsonResponse({ error: "Add a valid client email address before sending this document." }, 400);
  }

  const { data: business, error: businessError } = await supabase
    .from("businesses")
    .select("name, email, address")
    .eq("id", document.business_id)
    .eq("user_id", userData.user.id)
    .single();
  if (businessError || !business) return jsonResponse({ error: "The business profile for this document could not be found." }, 404);

  const pdfBytes = await createPdf(document, business as Business);
  let binary = "";
  for (let offset = 0; offset < pdfBytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...pdfBytes.subarray(offset, offset + 0x8000));
  }
  const pdfBase64 = btoa(binary);
  const safeNumber = document.invoice_number.replace(/[^a-z0-9-_]/gi, "-");
  const filename = `${document.document_type}-${safeNumber}.pdf`;
  const title = document.document_type === "quote" ? "Quote" : "Invoice";
  const total = money(calculateAmounts(document).total, document.currency);
  const subject = `Your ${title.toLowerCase()} ${document.invoice_number} from ${document.issuer_name}`;
  const html = [
    `<p>Hello ${escapeHtml(document.client_name)},</p>`,
    `<p>Please find your ${title.toLowerCase()} <strong>${escapeHtml(document.invoice_number)}</strong> from ${escapeHtml(document.issuer_name)} attached as a PDF.</p>`,
    `<p>Total: <strong>${escapeHtml(total)}</strong><br>`,
    `${document.document_type === "quote" ? "Valid until" : "Due date"}: ${escapeHtml(document.due_date)}</p>`,
    `<p>Thank you,<br>${escapeHtml(document.issuer_name)}</p>`,
  ].join("");
  const resendResponse = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${resendApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: emailFrom,
      to: [document.client_email],
      subject,
      html,
      attachments: [{ filename, content: pdfBase64 }],
    }),
  });
  if (!resendResponse.ok) {
    console.error("Resend rejected document email with status", resendResponse.status);
    return jsonResponse({ error: "The email provider rejected the message. Check that your sender address is verified in Resend." }, 502);
  }

  if (document.status === "draft") {
    const { data: updated, error: updateError } = await supabase
      .from("invoices")
      .update({ status: "sent" })
      .eq("id", document.id)
      .eq("user_id", userData.user.id)
      .eq("status", "draft")
      .select("id")
      .maybeSingle();
    if (updateError || !updated) {
      console.error("Email sent, but document status could not be updated", updateError?.message || "Document changed during send");
      return jsonResponse({
        message: "Email sent, but the document status could not be updated.",
        recipient: document.client_email,
        status_updated: false,
      });
    }
  }

  return jsonResponse({ message: "Document email sent.", recipient: document.client_email, status_updated: true });
});
