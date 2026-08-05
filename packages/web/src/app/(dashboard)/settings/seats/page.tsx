"use client";

/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useSubscription } from "@/hooks/useSubscription";

interface Seat {
  seat_email: string;
  created_at: string;
}

interface Violation {
  offending_email: string;
  attempted_drive_email: string;
  master_drive_email: string;
  created_at: string;
}

export default function SeatsPage() {
  const supabase = createClient();
  const { isPro } = useSubscription();
  const [seats, setSeats] = useState<Seat[]>([]);
  const [violations, setViolations] = useState<Violation[]>([]);
  const [seatCount, setSeatCount] = useState(0);
  const [maxSeats, setMaxSeats] = useState(9);
  const [masterDriveEmail, setMasterDriveEmail] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [newEmail, setNewEmail] = useState("");
  const [notice, setNotice] = useState<string | null>(null);

  const loadSeats = useCallback(async () => {
    setLoading(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        window.location.href = "/login?redirect=/settings/seats";
        return;
      }
      const res = await fetch("/api/payments/pro-seats", {
        headers: { authorization: `Bearer ${session.access_token}` },
      });
      if (res.ok) {
        const data = await res.json();
        setSeats(data.seats ?? []);
        setSeatCount(data.seatCount ?? 0);
        setMaxSeats(data.maxSeats ?? 9);
        setMasterDriveEmail(data.masterDriveEmail ?? null);
        setViolations(data.violations ?? []);
      }
    } catch (err) {
      console.error("Failed to load seats:", err);
    } finally {
      setLoading(false);
    }
  }, [supabase]);

  useEffect(() => { void loadSeats(); }, [loadSeats]);

  async function handleAdd() {
    const email = newEmail.toLowerCase().trim();
    if (!email.includes("@") || email.length > 254) {
      setNotice("Invalid email address.");
      return;
    }
    setAdding(true);
    setNotice(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return;
      const res = await fetch("/api/payments/pro-seats", {
        method: "POST",
        headers: { "Content-Type": "application/json", authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ email }),
      });
      const result = await res.json();
      if (!res.ok) {
        setNotice(result.error ?? "Failed to add seat.");
      } else {
        setNewEmail("");
        await loadSeats();
      }
    } catch (err) {
      console.error("Add seat failed:", err);
      setNotice("Failed to add seat.");
    } finally {
      setAdding(false);
    }
  }

  async function handleRemove(email: string) {
    setRemoving(email);
    setNotice(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return;
      const res = await fetch("/api/payments/pro-seats", {
        method: "DELETE",
        headers: { "Content-Type": "application/json", authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ email }),
      });
      if (res.ok) {
        await loadSeats();
      } else {
        setNotice("Failed to remove seat.");
      }
    } catch (err) {
      console.error("Remove seat failed:", err);
      setNotice("Failed to remove seat.");
    } finally {
      setRemoving(null);
    }
  }

  if (loading) {
    return (
      <div className="max-w-3xl mx-auto p-8 text-[#6B6B6B] text-sm">
        Loading Pro Seats…
      </div>
    );
  }

  if (!isPro) {
    return (
      <div className="max-w-3xl mx-auto p-8">
        <h1 className="text-xl font-bold text-[#F5F5F5] mb-2">Pro Seats</h1>
        <p className="text-sm text-[#6B6B6B] mb-6">
          Pro Seats are available on the Pro plan.
        </p>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto p-8 text-[#F5F5F5]">
      <h1 className="text-xl font-bold mb-2">Pro Seats</h1>
      <p className="text-sm text-[#6B6B6B] mb-6">
        Add up to {maxSeats} additional Google accounts to share your Pro subscription.
        All seats must connect the same Google Drive account.
      </p>

      {notice && (
        <div className="mb-4 rounded-md border border-[#2A2A2A] bg-[#111] px-4 py-3 text-xs text-[#F5F5F5]">
          {notice}
        </div>
      )}

      {/* Master Drive lock */}
      <section className="rounded-md border border-[#2A2A2A] bg-[#111] p-5 mb-4">
        <h2 className="text-sm font-semibold mb-2">Master Drive Account</h2>
        {masterDriveEmail ? (
          <div className="flex items-center gap-2">
            <span className="text-xs text-[#00FF88] font-mono">{masterDriveEmail}</span>
            <span className="text-[10px] text-[#6B6B6B]">(locked — all seats must use this Drive)</span>
          </div>
        ) : (
          <p className="text-xs text-[#6B6B6B]">
            Not locked yet. The first Drive account you connect will become the master.
          </p>
        )}
      </section>

      {/* Seat usage */}
      <section className="rounded-md border border-[#2A2A2A] bg-[#111] p-5 mb-4">
        <div className="flex justify-between items-center mb-3">
          <h2 className="text-sm font-semibold">Authorized Seats</h2>
          <span className="text-xs text-[#6B6B6B]">{seatCount} / {maxSeats} added (your account is auto-included)</span>
        </div>

        {seats.length === 0 ? (
          <p className="text-xs text-[#6B6B6B]">No additional seats added yet.</p>
        ) : (
          <div className="space-y-2">
            {seats.map((seat) => (
              <div key={seat.seat_email} className="flex justify-between items-center py-2 border-b border-[#1A1A1A] last:border-b-0">
                <span className="text-sm text-[#F5F5F5]">{seat.seat_email}</span>
                <button
                  disabled={removing === seat.seat_email}
                  onClick={() => handleRemove(seat.seat_email)}
                  className="text-xs text-[#00FF88] hover:underline disabled:opacity-50"
                >
                  {removing === seat.seat_email ? "Removing…" : "Remove"}
                </button>
              </div>
            ))}
          </div>
        )}

        {seatCount < maxSeats && (
          <div className="mt-4 flex gap-2">
            <input
              type="email"
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
              placeholder="google@example.com"
              className="flex-1 rounded-md border border-[#2A2A2A] bg-[#0A0A0A] px-3 py-2 text-xs text-[#F5F5F5] placeholder-[#444] outline-none focus:border-[#00FF88]/40"
            />
            <button
              disabled={adding || !newEmail.includes("@")}
              onClick={handleAdd}
              className="rounded-md bg-[#00FF88] px-4 py-2 text-xs font-bold text-black disabled:opacity-50 hover:bg-[#00D26A]"
            >
              {adding ? "Adding…" : "Add Seat"}
            </button>
          </div>
        )}
      </section>

      {/* Violations */}
      {violations.length > 0 && (
        <section className="rounded-md border border-[#00FF88]/30 bg-[#111] p-5">
          <h2 className="text-sm font-semibold mb-3 text-[#00FF88]">Drive Mismatch Flags</h2>
          <p className="text-xs text-[#6B6B6B] mb-3">
            These profiles connected a different Drive account and had Pro revoked.
            Reconnect the correct master Drive to restore Pro.
          </p>
          <div className="space-y-2">
            {violations.map((v, i) => (
              <div key={i} className="text-xs border-b border-[#1A1A1A] pb-2 last:border-b-0 last:pb-0">
                <div className="text-[#F5F5F5]">{v.offending_email}</div>
                <div className="text-[#6B6B6B]">
                  Connected {v.attempted_drive_email} (master is {v.master_drive_email})
                </div>
                <div className="text-[#444] text-[10px]">
                  {new Date(v.created_at).toLocaleString()}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
