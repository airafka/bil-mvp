package ru.billing.app.containerstock;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.servlet.HandlerInterceptor;
import org.springframework.web.servlet.config.annotation.InterceptorRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

/** Catch up before ownership-dependent reads, including after a clock jump or restart. */
@Configuration
public class OwnershipScheduleWebConfig implements WebMvcConfigurer {
    private final OwnershipScheduler scheduler;
    public OwnershipScheduleWebConfig(OwnershipScheduler scheduler) { this.scheduler=scheduler; }
    @Override public void addInterceptors(InterceptorRegistry registry) {
        registry.addInterceptor(new HandlerInterceptor() {
            @Override public boolean preHandle(HttpServletRequest request,HttpServletResponse response,Object handler) {
                scheduler.processDue();
                // Keep the order UI available to withdraw and correct a failed pending order.
                if(!request.getRequestURI().startsWith("/api/service-orders")) scheduler.requireCurrent();
                return true;
            }
        }).addPathPatterns("/api/service-orders/**","/api/container-owners/**","/api/container-remains/**","/api/containers/*/owner-history",
            "/api/container-storage-periods/**","/api/receiving-orders/**","/api/shipping-orders/**","/api/routes/**",
            "/api/comprehensive-service-orders/**");
    }
}
