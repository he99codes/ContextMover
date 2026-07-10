"use client";

import { useEffect, useState } from "react";

export interface CurrencyInfo {
  code: string;
  symbol: string;
  rate: number;
  isIndia: boolean;
}

const RATES: Record<string, { symbol: string; rate: number }> = {
  INR: { symbol: "₹", rate: 1 },
  USD: { symbol: "$", rate: 0.012 },
  EUR: { symbol: "€", rate: 0.011 },
  GBP: { symbol: "£", rate: 0.0095 },
  AUD: { symbol: "A$", rate: 0.018 },
  CAD: { symbol: "C$", rate: 0.016 },
  SGD: { symbol: "S$", rate: 0.016 },
  AED: { symbol: "AED", rate: 0.044 },
};

const COUNTRY_TO_CURRENCY: Record<string, string> = {
  IN: "INR", US: "USD", GB: "GBP", AU: "AUD",
  CA: "CAD", SG: "SGD", AE: "AED",
  DE: "EUR", FR: "EUR", IT: "EUR", ES: "EUR",
  NL: "EUR", BE: "EUR", AT: "EUR", PT: "EUR",
};

export function useCurrency(): CurrencyInfo {
  const [info, setInfo] = useState<CurrencyInfo>({
    code: "INR", symbol: "₹", rate: 1, isIndia: true,
  });

  useEffect(() => {
    fetch("https://ipapi.co/json/")
      .then((r) => r.json())
      .then((data) => {
        const country: string = data?.country_code ?? "IN";
        const currency = COUNTRY_TO_CURRENCY[country] ?? "USD";
        const { symbol, rate } = RATES[currency] ?? RATES.USD;
        setInfo({ code: currency, symbol, rate, isIndia: country === "IN" });
      })
      .catch(() => {
        // Default to INR on failure
      });
  }, []);

  return info;
}
