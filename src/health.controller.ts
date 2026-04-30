import { Controller, Get } from '@nestjs/common';

@Controller('health') // Bu manzil: /health bo'ladi
export class HealthController {
  @Get()
  check() {
    // Cron-job.org shunchaki 200 OK javobini kutadi
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
    };
  }
}
