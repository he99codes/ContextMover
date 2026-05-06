// packages/web/src/types/razorpay.d.ts
// Type declarations for the Razorpay client-side checkout JS loaded via CDN.

interface RazorpayPrefill {
  name?:    string;
  email?:   string;
  contact?: string;
}

interface RazorpayTheme {
  color?: string;
}

interface RazorpayModal {
  ondismiss?: () => void;
}

export interface RazorpayResponse {
  razorpay_payment_id: string;
  razorpay_order_id:   string;
  razorpay_signature:  string;
}

export interface RazorpayOptions {
  key:          string;
  amount:       number;
  currency:     string;
  name:         string;
  description?: string;
  order_id:     string;
  prefill?:     RazorpayPrefill;
  theme?:       RazorpayTheme;
  modal?:       RazorpayModal;
  handler:      (response: RazorpayResponse) => void;
}

interface RazorpayInstance {
  open():  void;
  close(): void;
}

interface RazorpayConstructor {
  new (options: RazorpayOptions): RazorpayInstance;
}

declare global {
  interface Window {
    Razorpay: RazorpayConstructor;
  }
}
