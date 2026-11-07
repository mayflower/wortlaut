import React, { useState, useEffect } from 'react';
import { Eye, EyeOff, KeyRound, MailCheck, ShieldCheck, Trash2, Users } from 'lucide-react';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from './ui/primitives';

export interface AuthGateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentToken: string;
  authError: string | null;
  onSaveToken: (token: string) => void;
}

export function AuthGateDialog({
  open,
  onOpenChange,
  currentToken,
  authError,
  onSaveToken,
}: AuthGateDialogProps) {
  const [value, setValue] = useState(currentToken);
  const [showPlain, setShowPlain] = useState(false);

  useEffect(() => {
    setValue(currentToken);
  }, [currentToken, open]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSaveToken(value.trim());
    if (value.trim()) {
      onOpenChange(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-lg font-bold text-white">
            <KeyRound className="h-5 w-5 text-sky-400" />
            <span>Mit wortlaut verbinden</span>
          </DialogTitle>
          <DialogDescription className="text-xs text-slate-400">
            wortlaut läuft selbstgehostet in Ihrer Infrastruktur. Melden Sie
            sich mit Ihrem Team-Zugangsschlüssel oder einem Lese-Token aus einer
            Transkript-E-Mail an.
          </DialogDescription>
        </DialogHeader>

        {authError && (
          <div className="mb-4 rounded-lg border border-red-800/80 bg-red-950/60 p-3 text-xs text-red-200">
            {authError}
          </div>
        )}

        <div className="mb-4 grid grid-cols-1 gap-2.5 sm:grid-cols-2">
          <div className="rounded-xl border border-slate-800 bg-slate-950/80 p-3 text-xs space-y-1.5">
            <div className="flex items-center gap-2 font-semibold text-sky-300">
              <Users className="h-4 w-4 shrink-0 text-sky-400" />
              <span>1. Team- / Operator-Schlüssel</span>
            </div>
            <p className="text-[11px] leading-relaxed text-slate-400">
              Für neue Meeting-Aufnahmen, Kalender-Einladungen und alle
              Transkripte. Erhältlich bei Ihrem Plattform-Team (Kubernetes-Secret{' '}
              <code className="text-slate-300">wortlaut-runtime</code>).
            </p>
          </div>

          <div className="rounded-xl border border-slate-800 bg-slate-950/80 p-3 text-xs space-y-1.5">
            <div className="flex items-center gap-2 font-semibold text-emerald-300">
              <MailCheck className="h-4 w-4 shrink-0 text-emerald-400" />
              <span>2. Einzel-Transkript lesen</span>
            </div>
            <p className="text-[11px] leading-relaxed text-slate-400">
              Öffnen Sie direkt den Link aus Ihrer Ergebnis-E-Mail oder fügen
              Sie einen Lese-Token (<code className="text-slate-300">wortlaut-read-…</code>)
              für genau eine Besprechung ein.
            </p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <label
              htmlFor="api-token"
              className="block text-xs font-semibold uppercase tracking-wider text-slate-400"
            >
              Zugangsschlüssel (Team-Token oder Lese-Token)
            </label>
            <div className="relative">
              <input
                id="api-token"
                type={showPlain ? 'text' : 'password'}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder="Schlüssel hier einfügen…"
                autoFocus
                className="w-full rounded-lg border border-slate-700 bg-slate-950 pl-3 pr-10 py-2.5 text-sm text-white placeholder-slate-500 focus:border-sky-500 focus:outline-none"
              />
              <button
                type="button"
                onClick={() => setShowPlain((v) => !v)}
                title={showPlain ? 'Schlüssel verbergen' : 'Schlüssel anzeigen'}
                className="absolute right-2.5 top-2.5 text-slate-400 hover:text-slate-200 cursor-pointer"
              >
                {showPlain ? (
                  <EyeOff className="h-4 w-4" />
                ) : (
                  <Eye className="h-4 w-4" />
                )}
              </button>
            </div>
            <p className="flex items-center gap-1.5 text-[11px] text-slate-500">
              <ShieldCheck className="h-3.5 w-3.5 text-slate-400" />
              <span>
                Wird ausschließlich lokal in Ihrem Browser gespeichert.
              </span>
            </p>
          </div>

          <div className="flex items-center justify-between gap-2 pt-1">
            {currentToken ? (
              <Button
                type="button"
                variant="danger"
                size="sm"
                onClick={() => {
                  setValue('');
                  onSaveToken('');
                }}
              >
                <Trash2 className="h-3.5 w-3.5" />
                <span>Abmelden / Löschen</span>
              </Button>
            ) : (
              <div />
            )}
            <div className="flex items-center gap-2">
              {currentToken && (
                <Button
                  type="button"
                  variant="ghost"
                  size="md"
                  onClick={() => onOpenChange(false)}
                >
                  Abbrechen
                </Button>
              )}
              <Button type="submit" variant="primary" size="md" id="save-token">
                Jetzt verbinden
              </Button>
            </div>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
