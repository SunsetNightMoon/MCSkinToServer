export function ErrorMessage({ message }: { message: string }) {
  return (
    <div style={{
      padding: '20px',
      textAlign: 'center',
      color: '#ff4d4f',
    }}>
      <h3>{message ? message : 'Error'}</h3>
    </div>
  );
}
