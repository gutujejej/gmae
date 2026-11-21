import UploadForm from '@/components/UploadForm';

export const metadata = { title: 'Upload' };

export default function UploadPage() {
  return (
    <div className="page">
      <UploadForm />
    </div>
  );
}
