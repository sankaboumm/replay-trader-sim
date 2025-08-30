import { memo, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Upload } from 'lucide-react';

interface FileUploadProps {
  onFileSelect: (file: File) => void;
  disabled?: boolean;
}

export const FileUpload = memo(function FileUpload({
  onFileSelect,
  disabled = false
}: FileUploadProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleClick = () => {
    if (!disabled) fileInputRef.current?.click();
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      onFileSelect(file);
      if (fileInputRef.current) fileInputRef.current.value = '';
    } else {
      console.log('🔥 FileUpload: No file selected');
    }
  };

  return (
    <>
      <Button
        variant="outline"
        onClick={handleClick}
        disabled={disabled}
        className="flex items-center gap-2"
      >
        <Upload className="h-4 w-4" />
        Charger CSV/Parquet
      </Button>
      <input
        ref={fileInputRef}
        type="file"
        accept=".parquet,.csv"
        onChange={handleFileChange}
        className="hidden"
      />
    </>
  );
});