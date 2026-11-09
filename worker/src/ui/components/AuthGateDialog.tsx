import React, { useState, useEffect } from 'react';
import { Eye, EyeOff, KeyRound, LogIn, ShieldCheck, Trash2, User } from 'lucide-react';
import { getInstanceInfo } from '../api';
import type { AuthMode } from '../types';
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
  authMode: AuthMode;
  authError: string | null;
  onSaveToken: (token: string) => void;
  onStartOidcLogin: () => void;
}

export function AuthGateDialog({
  open,
  onOpenChange,
  currentToken,
  authMode,
  authError,
  onSaveToken,
  onStartOidcLogin,
}: AuthGateDialogProps) {
  const instance = getInstanceInfo();
  const oidcEnabled = Boolean(instance.oidc?.enabled);
  const currentUser = authMode.kind === 'operator' ? authMode.user : undefined;
  const [value, setValue] = useState(currentToken);
  const [showPlain, setShowPlain] = useState(false);

  useEffect(() => {
    setValue(currentUser ? '' : currentToken);
  }, [currentToken, currentUser, open]);

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
            <span>Anmeldung &amp; Zugang</span>
          </DialogTitle>
          <DialogDescription className="text-xs text-slate-400">
            Melden Sie sich per Mayflower-SSO (Dex) an oder verwenden Sie einen
            Lese-Token bzw. API-Schlüssel.
          </DialogDescription>
        </DialogHeader>

        {authError && (
          <div className="mb-4 rounded-lg border border-red-800/80 bg-red-950/60 p-3 text-xs text-red-200">
            {authError}
          </div>
        )}

        {currentUser && (
          <div className="mb-4 flex items-center justify-between gap-3 rounded-xl border border-slate-800 bg-slate-950/90 p-3.5 text-xs">
            <div className="flex items-center gap-2.5 min-w-0">
              <User className="h-4 w-4 shrink-0 text-sky-400" />
              <div className="truncate">
                <div className="font-semibold text-white truncate">
                  {currentUser.name}
                </div>
                <div className="text-slate-400 truncate">{currentUser.email}</div>
              </div>
            </div>
            <Button
              type="button"
              variant="danger"
              size="sm"
              onClick={() => {
                setValue('');
                onSaveToken('');
                onOpenChange(false);
              }}
            >
              <Trash2 className="h-3.5 w-3.5" />
              <span>Abmelden</span>
            </Button>
          </div>
        )}

        {oidcEnabled && (
          <div className="mb-4">
            <Button
              type="button"
              variant="primary"
              size="md"
              onClick={onStartOidcLogin}
              className="w-full justify-center py-2.5"
            >
              <LogIn className="h-4 w-4" />
              <span>
                {currentUser
                  ? 'SSO-Sitzung erneuern / Konto wechseln'
                  : 'Mit Mayflower-Account anmelden (SSO)'}
              </span>
            </Button>
          </div>
        )}

        <form
          onSubmit={handleSubmit}
          className={
            oidcEnabled
              ? 'space-y-4 border-t border-slate-800/80 pt-4'
              : 'space-y-4'
          }
        >
          <div className="space-y-1.5">
            <label
              htmlFor="api-token"
              className="block text-xs font-semibold uppercase tracking-wider text-slate-400"
            >
              Alternativ: Lese-Token (wortlaut-read-…) oder API-Schlüssel
            </label>
            <div className="relative">
              <input
                id="api-token"
                type={showPlain ? 'text' : 'password'}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder="Token hier einfügen…"
                autoFocus={!oidcEnabled}
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
            {currentToken && !currentUser ? (
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
              <Button
                type="button"
                variant="ghost"
                size="md"
                onClick={() => onOpenChange(false)}
              >
                Schließen
              </Button>
              <Button
                type="submit"
                variant={oidcEnabled ? 'outline' : 'primary'}
                size="md"
                id="save-token"
                disabled={!value.trim()}
              >
                Token übernehmen
              </Button>
            </div>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
