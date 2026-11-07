import React, { useState, useEffect } from 'react';
import { KeyRound, ShieldCheck, Terminal, Trash2 } from 'lucide-react';
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
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-lg font-semibold text-white">
            <KeyRound className="h-5 w-5 text-sky-400" />
            <span>Zugang konfigurieren</span>
          </DialogTitle>
          <DialogDescription className="text-xs text-slate-400">
            Geben Sie Ihren Operator-Bearer-Token oder einen aufnahmegebundenen
            Lese-Token ein.
          </DialogDescription>
        </DialogHeader>

        {authError && (
          <div className="mb-4 rounded-lg border border-red-800/80 bg-red-950/60 p-3 text-xs text-red-200">
            {authError}
          </div>
        )}

        <div className="mb-4 space-y-2.5 rounded-lg border border-slate-800 bg-slate-950/70 p-3.5 text-xs text-slate-300">
          <div className="flex items-start gap-2.5">
            <Terminal className="mt-0.5 h-4 w-4 shrink-0 text-sky-400" />
            <div>
              <strong className="text-slate-100">Operator-Token:</strong> Voller
              Zugriff auf alle Aufnahmen, Ad-hoc-Meeting-Starts, Kalender-Importe
              und Diagnose-Daten.
            </div>
          </div>
          <div className="flex items-start gap-2.5">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
            <div>
              <strong className="text-slate-100">
                Lese-Token (<code>wortlaut-read-…</code>):
              </strong>{' '}
              Direkter Lese- und Export-Zugriff auf genau eine freigegebene
              Besprechung.
            </div>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <label
              htmlFor="api-token"
              className="block text-xs font-semibold uppercase tracking-wider text-slate-400"
            >
              Bearer Token
            </label>
            <input
              id="api-token"
              type="password"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="WORTLAUT_API_TOKEN oder wortlaut-read-..."
              autoFocus
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white placeholder-slate-500 focus:border-sky-500 focus:outline-none"
            />
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
                <span>Token löschen</span>
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
                Verbinden
              </Button>
            </div>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
