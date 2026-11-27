import React, { useEffect, useState } from 'react';
import { KeyRound, LogIn, LogOut, Trash2 } from 'lucide-react';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { Card, Layout, LayoutContent } from '@astryxdesign/core/Layout';
import { FormLayout } from '@astryxdesign/core/FormLayout';
import { TextInput } from '@astryxdesign/core/TextInput';
import { Button } from '@astryxdesign/core/Button';
import { Banner } from '@astryxdesign/core/Banner';
import { Avatar } from '@astryxdesign/core/Avatar';
import { Divider } from '@astryxdesign/core/Divider';
import { HStack } from '@astryxdesign/core/HStack';
import { VStack } from '@astryxdesign/core/VStack';
import { Text } from '@astryxdesign/core/Text';
import { getConfiguredAuthProviders, getInstanceInfo } from '../api';
import { useI18n } from '../i18n';
import type { AuthMode, AuthProviderId, AuthProviderOption } from '../types';

export function AuthProviderIcon({ provider }: { provider: AuthProviderId }) {
  if (provider === 'google') {
    return (
      <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-white p-0.5">
        <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" aria-hidden="true">
          <path
            fill="#4285F4"
            d="M23.49 12.27c0-.79-.07-1.54-.19-2.27H12v4.51h6.47a5.53 5.53 0 0 1-2.4 3.63v3.01h3.88c2.27-2.09 3.54-5.17 3.54-8.88Z"
          />
          <path
            fill="#34A853"
            d="M12 24c3.24 0 5.95-1.07 7.94-2.91l-3.88-3.01c-1.08.72-2.45 1.15-4.06 1.15-3.12 0-5.77-2.11-6.72-4.95H1.28v3.11A12 12 0 0 0 12 24Z"
          />
          <path
            fill="#FBBC05"
            d="M5.28 14.28A7.2 7.2 0 0 1 4.9 12c0-.79.14-1.56.38-2.28V6.61H1.28A12 12 0 0 0 0 12c0 1.94.46 3.77 1.28 5.39l4-3.11Z"
          />
          <path
            fill="#EA4335"
            d="M12 4.77c1.76 0 3.34.61 4.59 1.8l3.44-3.44C17.95 1.19 15.24 0 12 0A12 12 0 0 0 1.28 6.61l4 3.11C6.23 6.88 8.88 4.77 12 4.77Z"
          />
        </svg>
      </span>
    );
  }
  if (provider === 'entra') {
    return (
      <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-sm bg-white p-0.5">
        <svg className="h-3.5 w-3.5" viewBox="0 0 21 21" aria-hidden="true">
          <rect x="1" y="1" width="9" height="9" fill="#F25022" />
          <rect x="11" y="1" width="9" height="9" fill="#7FBA00" />
          <rect x="1" y="11" width="9" height="9" fill="#00A4EF" />
          <rect x="11" y="11" width="9" height="9" fill="#FFB900" />
        </svg>
      </span>
    );
  }
  return <LogIn className="h-4 w-4" />;
}

export function formatAuthProviderLabel(
  provider: AuthProviderOption,
  tr: (de: string, en: string) => string,
  renew = false
): string {
  if (renew) {
    if (provider.id === 'google') {
      return tr('Mit Google neu anmelden', 'Switch / renew Google account');
    }
    if (provider.id === 'entra') {
      return tr(
        'Mit Microsoft (Entra ID) neu anmelden',
        'Switch / renew Microsoft (Entra ID) account'
      );
    }
    return tr(
      'SSO-Sitzung erneuern / Konto wechseln',
      'Renew SSO session / switch account'
    );
  }
  if (provider.id === 'google') {
    return tr('Mit Google anmelden', 'Sign in with Google');
  }
  if (provider.id === 'entra') {
    return tr('Mit Microsoft (Entra ID) anmelden', 'Sign in with Microsoft (Entra ID)');
  }
  if (provider.label && provider.label !== 'SSO (OIDC)') {
    return tr(`Mit ${provider.label} anmelden`, `Sign in with ${provider.label}`);
  }
  return tr('Mit SSO anmelden (OIDC)', 'Sign in with SSO (OIDC)');
}

export interface AuthGateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentToken: string;
  authMode: AuthMode;
  authError: string | null;
  onSaveToken: (token: string) => void;
  onStartOidcLogin: (providerId?: AuthProviderId) => void;
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
  const { tr } = useI18n();
  const instance = getInstanceInfo();
  const authProviders = getConfiguredAuthProviders(instance);
  const oidcEnabled = authProviders.length > 0;
  const currentUser = authMode.kind === 'operator' ? authMode.user : undefined;
  const [value, setValue] = useState(currentToken);

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
    <Dialog
      isOpen={open}
      onOpenChange={onOpenChange}
      width={480}
      purpose="form"
    >
      <Layout
        height="auto"
        header={
          <DialogHeader
            title={tr('Anmeldung & Zugang', 'Sign in & Access')}
            subtitle={tr(
              'Melden Sie sich mit Ihrem Konto an oder verwenden Sie einen Lese-Token bzw. API-Schlüssel.',
              'Sign in with your account or enter a read-only share token or API key.'
            )}
            onOpenChange={onOpenChange}
          />
        }
        content={
          <LayoutContent>
            <VStack gap={3}>
              {authError && (
                <Banner status="error" container="card" title={authError} />
              )}

              {currentUser && (
                <Card variant="muted" padding={3}>
                  <HStack justify="between" vAlign="center" gap={3}>
                    <HStack gap={2} vAlign="center">
                      <Avatar size="sm" shape="circle" name={currentUser.name} />
                      <VStack gap={0}>
                        <Text type="body" weight="semibold" color="primary">
                          {currentUser.name}
                        </Text>
                        <Text type="supporting" color="secondary">
                          {currentUser.email}
                        </Text>
                      </VStack>
                    </HStack>

                    <Button
                      type="button"
                      variant="destructive"
                      size="sm"
                      icon={<LogOut className="h-3.5 w-3.5" />}
                      label={tr('Abmelden', 'Sign out')}
                      onClick={() => {
                        setValue('');
                        onSaveToken('');
                        onOpenChange(false);
                      }}
                    />
                  </HStack>
                </Card>
              )}

              {oidcEnabled && (
                <VStack gap={2}>
                  {authProviders.map((provider, idx) => (
                    <span
                      key={provider.id}
                      data-testid={`auth-dialog-provider-${provider.id}`}
                      className="contents"
                    >
                      <Button
                        type="button"
                        variant={idx === 0 ? 'primary' : 'secondary'}
                        size="md"
                        width="fill"
                        icon={<AuthProviderIcon provider={provider.id} />}
                        label={formatAuthProviderLabel(
                          provider,
                          tr,
                          Boolean(currentUser)
                        )}
                        onClick={() => onStartOidcLogin(provider.id)}
                      />
                    </span>
                  ))}
                </VStack>
              )}

              {oidcEnabled && <Divider variant="subtle" />}

              <form onSubmit={handleSubmit}>
                <FormLayout direction="vertical">
                  <div id="api-token-field">
                    <TextInput
                      type="password"
                      label={tr(
                        'Alternativ: Lese-Token (wortlaut-read-…) oder API-Schlüssel',
                        'Alternative: Read-only token (wortlaut-read-…) or API key'
                      )}
                      description={tr(
                        'Wird ausschließlich lokal in Ihrem Browser gespeichert.',
                        'Stored exclusively in your local browser storage.'
                      )}
                      value={value}
                      onChange={setValue}
                      placeholder={tr(
                        'Token hier einfügen…',
                        'Paste token here…'
                      )}
                      startIcon={<KeyRound className="h-4 w-4" />}
                    />
                  </div>

                  <HStack justify="between" vAlign="center" gap={2}>
                    {currentToken && !currentUser ? (
                      <Button
                        type="button"
                        variant="destructive"
                        size="sm"
                        icon={<Trash2 className="h-3.5 w-3.5" />}
                        label={tr('Abmelden / Löschen', 'Sign out / Clear')}
                        onClick={() => {
                          setValue('');
                          onSaveToken('');
                        }}
                      />
                    ) : (
                      <div />
                    )}

                    <HStack gap={2}>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        label={tr('Schließen', 'Close')}
                        onClick={() => onOpenChange(false)}
                      />
                      <span id="save-token">
                        <Button
                          type="submit"
                          variant={oidcEnabled ? 'secondary' : 'primary'}
                          size="sm"
                          isDisabled={!value.trim()}
                          label={tr('Token übernehmen', 'Apply token')}
                        />
                      </span>
                    </HStack>
                  </HStack>
                </FormLayout>
              </form>
            </VStack>
          </LayoutContent>
        }
      />
    </Dialog>
  );
}
