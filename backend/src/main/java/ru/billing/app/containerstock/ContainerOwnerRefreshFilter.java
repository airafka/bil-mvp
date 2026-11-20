package ru.billing.app.containerstock;

import java.io.IOException;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

@Component
public class ContainerOwnerRefreshFilter extends OncePerRequestFilter {
    private final ContainerOwnerRefreshService owners;
    public ContainerOwnerRefreshFilter(ContainerOwnerRefreshService owners) { this.owners=owners; }
    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        return !request.getServletPath().startsWith("/api/") || request.getMethod().equals("OPTIONS");
    }
    @Override
    protected void doFilterInternal(HttpServletRequest request,HttpServletResponse response,FilterChain chain)
            throws ServletException,IOException {
        owners.refresh();
        chain.doFilter(request,response);
    }
}
