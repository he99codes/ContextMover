import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { Resend } from 'npm:resend';

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY');
const ADMIN_EMAIL = Deno.env.get('ADMIN_EMAIL');

serve(async (req) => {
  if (!RESEND_API_KEY || !ADMIN_EMAIL) {
    return new Response('Missing RESEND_API_KEY or ADMIN_EMAIL environment variables', { status: 500 });
  }

  try {
    const { record } = await req.json();
    const resend = new Resend(RESEND_API_KEY);

    const { platform_id, error_message, href, reported_at } = record;

    await resend.emails.send({
      from: 'bug-reporter@contextmover.com',
      to: ADMIN_EMAIL,
      subject: `New Scraper Bug Report for ${platform_id}`,
      html: `
        <h1>Scraper Bug Report</h1>
        <p>A new bug has been reported for the <strong>${platform_id}</strong> scraper.</p>
        <ul>
          <li><strong>Error:</strong> ${error_message}</li>
          <li><strong>URL:</strong> <a href="${href}">${href}</a></li>
          <li><strong>Reported At:</strong> ${new Date(reported_at).toLocaleString()}</li>
        </ul>
        <p>Please check the admin panel for more details.</p>
      `,
    });

    return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
  } catch (error) { 
    return new Response(String(error?.message ?? error), { status: 500 });
  }
});
