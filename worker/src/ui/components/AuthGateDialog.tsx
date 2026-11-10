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
import { getInstanceInfo } from '../api';
import type { AuthMode } from '../types';

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
            title="Anmeldung & Zugang"
            subtitle="Melden Sie sich per Mayflower-SSO (Dex) an oder verwenden Sie einen Lese-Token bzw. API-Schlüssel."
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
                      label="Abmelden"
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
                <Button
                  type="button"
                  variant="primary"
                  size="md"
                  width="fill"
                  icon={<LogIn className="h-4 w-4" />}
                  label={
                    currentUser
                      ? 'SSO-Sitzung erneuern / Konto wechseln'
                      : 'Mit Mayflower-Account anmelden (SSO)'
                  }
                  onClick={onStartOidcLogin}
                />
              )}

              {oidcEnabled && <Divider variant="subtle" />}

              <form onSubmit={handleSubmit}>
                <FormLayout direction="vertical">
                  <div id="api-token-field">
                    <TextInput
                      type="password"
                      label="Alternativ: Lese-Token (wortlaut-read-…) oder API-Schlüssel"
                      description="Wird ausschließlich lokal in Ihrem Browser gespeichert."
                      value={value}
                      onChange={setValue}
                      placeholder="Token hier einfügen…"
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
                        label="Abmelden / Löschen"
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
                        label="Schließen"
                        onClick={() => onOpenChange(false)}
                      />
                      <span id="save-token">
                        <Button
                          type="submit"
                          variant={oidcEnabled ? 'secondary' : 'primary'}
                          size="sm"
                          isDisabled={!value.trim()}
                          label="Token übernehmen"
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
