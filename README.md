# Masase Commerce Invoices

A responsive invoice app hosted as a static site on GitHub Pages. Supabase provides account sign-in and private, cross-device invoice storage.

## What it does

- Manage multiple businesses, including business contact details and an uploaded logo.
- View an all-business dashboard and individual business dashboards with client and document visualizations.
- Save, search, and reuse client contact details within each business.
- Create, edit, search, print, and delete quotes and invoices; convert a quote to an invoice.
- Add line items, tax, currency, status, dates, and notes.
- Apply discounts as a percentage or fixed amount. A negative discount amount is treated as a surcharge.
- Calculate totals and print or save quotes and invoices as PDFs.
- Email a saved quote or invoice PDF directly to the client's email address.
- Keep each account's invoices private with Supabase authentication and row-level security.

The default currency is ZAR. Change the currency code on each invoice when needed.

## Set up cloud storage

1. Create a Supabase project.
2. In the Supabase SQL Editor, run [`supabase/schema.sql`](./supabase/schema.sql). It creates the business, client, document, and logo-storage policies. If you already set up the earlier invoice-only version, this script also adds the new columns and creates a business profile for existing invoices.
3. In Supabase project settings, copy the Project URL and the publishable key (or legacy `anon` key).
4. Add those values to [`config.js`](./config.js):

   ```js
   export const SUPABASE_URL = "https://your-project.supabase.co";
   export const SUPABASE_ANON_KEY = "your-public-anon-key";
   ```

   The publishable/anon key is intended for browser use. Never put a Supabase secret or `service_role` key in this file. Row-level security is enabled for invoices; keep the policies in the SQL setup enabled.

5. In Supabase Authentication settings, configure the site URL and allowed redirect URLs to include your GitHub Pages URL (for example, `https://your-user.github.io/your-repository/`). For a custom domain, add that URL too.
6. Set the repository's default branch to `main` and push the app. In GitHub, open **Settings → Pages** and select **GitHub Actions** as the build and deployment source. The workflow in `.github/workflows/deploy.yml` deploys the site on every push to `main`.
7. Open the Pages URL and create an account, then create your first business. If email confirmation is enabled in Supabase, confirm your email before signing in.

Because GitHub Pages is static hosting, the Supabase URL and publishable/anon key in `config.js` are visible to site visitors. This is expected: authentication and row-level security—not hiding the public key—protect invoice data.

## Set up customer email

Customer emails are sent by a Supabase Edge Function through Resend. The Resend API key must only be stored as a Supabase function secret; never add it to `config.js` or the GitHub repository.

1. Create a Resend account and verify a sending domain. Copy its API key and choose a sender address on that verified domain, such as `Masase Commerce <invoices@your-domain.com>`.
2. Install the Supabase CLI, sign in with `npx supabase login`, and link this repository to your project with `npx supabase link --project-ref iuuhshxpepccqjypreti`.
3. Set the email provider secrets and deploy the function from the repository root:

   ```powershell
   npx supabase secrets set RESEND_API_KEY=re_your_key "EMAIL_FROM=Masase Commerce <invoices@your-domain.com>"
   npx supabase functions deploy send-document-email
   ```

4. In the app, save a quote or invoice with a valid client email address, then choose **Email PDF** in its document actions. Successfully emailed draft documents are marked as sent.

## Local preview

Serve the repository root with any static HTTP server, then open its local URL. ES modules and authentication do not work reliably from a `file://` URL. Cloud features require the Supabase setup above and an allowed redirect URL.
