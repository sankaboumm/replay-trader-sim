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
    fileInputRef.current?.click();
  };

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    console.log('🔥 FileUpload: File selected from input');
    console.log('🔥 Event target:', event.target);
    console.log('🔥 Files:', event.target.files);
    const file = event.target.files?.[0];
    if (file) {
      console.log('🔥 FileUpload: Calling onFileSelect with file:', file.name);
      console.log('🔥 onFileSelect function:', onFileSelect);
      onFileSelect(file);
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
        Charger Parquet
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