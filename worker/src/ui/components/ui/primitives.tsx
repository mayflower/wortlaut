import React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import * as TabsPrimitive from '@radix-ui/react-tabs';
import * as DropdownPrimitive from '@radix-ui/react-dropdown-menu';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { X } from 'lucide-react';
import type { ParticipationState, Provider } from '../../types';
import { PARTICIPATION_LABELS, PROVIDER_LABELS } from '../../api';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
}

export function Button({
  className,
  variant = 'secondary',
  size = 'md',
  ...props
}: ButtonProps) {
  const variants = {
    primary:
      'bg-sky-600 text-white hover:bg-sky-500 border border-sky-500/80 shadow-xs',
    secondary:
      'bg-slate-800 text-slate-100 hover:bg-slate-700 border border-slate-700',
    outline:
      'bg-transparent text-slate-200 hover:bg-slate-800/70 border border-slate-700',
    ghost: 'bg-transparent text-slate-300 hover:bg-slate-800 hover:text-white',
    danger:
      'bg-red-950/80 text-red-200 hover:bg-red-900 border border-red-800/80',
  };
  const sizes = {
    sm: 'px-2.5 py-1 text-xs rounded-md gap-1.5',
    md: 'px-3.5 py-1.5 text-sm rounded-lg gap-2',
    lg: 'px-4 py-2 text-sm rounded-lg gap-2',
  };
  return (
    <button
      className={cn(
        'inline-flex items-center justify-center font-medium transition-colors cursor-pointer disabled:opacity-50 disabled:pointer-events-none',
        variants[variant],
        sizes[size],
        className
      )}
      {...props}
    />
  );
}

export function ProviderBadge({
  provider,
  className,
}: {
  provider: Provider;
  className?: string;
}) {
  const styles: Record<Provider, string> = {
    google_meet:
      'bg-emerald-950/90 text-emerald-300 border-emerald-800/80',
    teams: 'bg-indigo-950/90 text-indigo-300 border-indigo-800/80',
    webex: 'bg-sky-950/90 text-sky-300 border-sky-800/80',
  };
  return (
    <span
      className={cn(
        'inline-flex items-center px-2 py-0.5 rounded-md text-xs font-semibold border',
        styles[provider] || 'bg-slate-800 text-slate-200 border-slate-700',
        className
      )}
    >
      {PROVIDER_LABELS[provider] || provider}
    </span>
  );
}

export function StatusBadge({
  participation,
  processing,
  hasError,
  className,
}: {
  participation: ParticipationState;
  processing?: string;
  hasError?: boolean;
  className?: string;
}) {
  let color = 'bg-slate-800 text-slate-300 border-slate-700';
  let label = PARTICIPATION_LABELS[participation] || participation;

  if (participation === 'capturing') {
    color = 'bg-emerald-950/90 text-emerald-300 border-emerald-700/80';
  } else if (participation === 'waiting_admission') {
    color = 'bg-amber-950/90 text-amber-200 border-amber-700/80 animate-pulse';
  } else if (
    participation === 'joining' ||
    participation === 'preparing' ||
    participation === 'starting'
  ) {
    color = 'bg-sky-950/90 text-sky-300 border-sky-700/80';
  } else if (participation === 'scheduled') {
    color = 'bg-slate-800/90 text-slate-300 border-slate-700';
  } else if (participation === 'ended') {
    if (hasError || processing === 'failed') {
      color = 'bg-red-950/90 text-red-300 border-red-800/80';
    } else if (processing === 'completed') {
      color = 'bg-emerald-950/60 text-emerald-300 border-emerald-800/60';
      label = 'Transkript fertig';
    } else {
      color = 'bg-sky-950/60 text-sky-300 border-sky-800/60';
      label = 'Verarbeitet Audio…';
    }
  }

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium border',
        color,
        className
      )}
    >
      {participation === 'capturing' && (
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-ping" />
      )}
      {label}
    </span>
  );
}

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;

export function DialogContent({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-black/70 backdrop-blur-xs" />
      <DialogPrimitive.Content
        className={cn(
          'fixed left-1/2 top-1/2 z-50 w-full max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-xl border border-slate-700/90 bg-slate-900 p-6 shadow-2xl focus:outline-none',
          className
        )}
      >
        {children}
        <DialogPrimitive.Close className="absolute right-4 top-4 rounded-md p-1 text-slate-400 hover:bg-slate-800 hover:text-slate-100 cursor-pointer">
          <X className="h-4 w-4" />
          <span className="sr-only">Schließen</span>
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export function DialogHeader({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <div className={cn('mb-4 space-y-1', className)}>{children}</div>;
}

export const DialogTitle = DialogPrimitive.Title;
export const DialogDescription = DialogPrimitive.Description;

export const Tabs = TabsPrimitive.Root;

export function TabsList({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <TabsPrimitive.List
      className={cn(
        'inline-flex items-center gap-1 rounded-lg bg-slate-900/90 p-1 border border-slate-800',
        className
      )}
    >
      {children}
    </TabsPrimitive.List>
  );
}

export function TabsTrigger({
  children,
  value,
  className,
}: {
  children: React.ReactNode;
  value: string;
  className?: string;
}) {
  return (
    <TabsPrimitive.Trigger
      value={value}
      className={cn(
        'inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-xs font-semibold text-slate-400 transition-all cursor-pointer data-[state=active]:bg-slate-800 data-[state=active]:text-sky-400 data-[state=active]:shadow-xs hover:text-slate-200',
        className
      )}
    >
      {children}
    </TabsPrimitive.Trigger>
  );
}

export const TabsContent = TabsPrimitive.Content;

export const DropdownMenu = DropdownPrimitive.Root;
export const DropdownMenuTrigger = DropdownPrimitive.Trigger;
export const DropdownMenuPortal = DropdownPrimitive.Portal;
export const DropdownMenuContent = DropdownPrimitive.Content;
export const DropdownMenuItem = DropdownPrimitive.Item;

export const TooltipProvider = TooltipPrimitive.Provider;
export const Tooltip = TooltipPrimitive.Root;
export const TooltipTrigger = TooltipPrimitive.Trigger;
export const TooltipContent = TooltipPrimitive.Content;
