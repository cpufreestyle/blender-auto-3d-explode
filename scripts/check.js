import http from 'http';

// Check backend
http.get('http://localhost:3001/api/health', (res) => {
  let d = '';
  res.on('data', c => d += c);
  res.on('end', () => {
    console.log('BACKEND:', d);
    // Check frontend
    http.get('http://localhost:8080/', (res2) => {
      console.log('FRONTEND: HTTP', res2.statusCode);
      process.exit(0);
    }).on('error', (e) => {
      console.log('FRONTEND: DOWN -', e.message);
      process.exit(0);
    });
  });
}).on('error', (e) => {
  console.log('BACKEND: DOWN -', e.message);
  console.log('FRONTEND: skipped');
  process.exit(1);
});
