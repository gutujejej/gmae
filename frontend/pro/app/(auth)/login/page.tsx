import { Suspense } from 'react';
import { LoginForm } from '@/components/AuthForms';

export const metadata = { title: 'Log in' };

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}
